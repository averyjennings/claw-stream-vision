/**
 * Twitch Audio Capture
 * Extracts audio from a Twitch stream for speech-to-text transcription
 * Used with TwitchStreamCapture for mobile streaming setup
 */

import { spawn, type ChildProcess } from "child_process"
import * as fs from "fs"
import * as path from "path"
import OpenAI from "openai"

export interface TranscriptMessage {
  text: string
  timestamp: number
}

export interface TwitchAudioCaptureConfig {
  channel: string
  openaiApiKey: string
  chunkDurationSeconds?: number
  quality?: string
}

type TranscriptHandler = (transcript: TranscriptMessage) => void

export class TwitchAudioCapture {
  private config: TwitchAudioCaptureConfig
  private openai: OpenAI
  private isRunning = false
  private handlers: TranscriptHandler[] = []
  private tempDir: string
  private chunkIndex = 0
  private streamlinkProcess: ChildProcess | null = null
  private ffmpegProcess: ChildProcess | null = null

  // Buffer for combining incomplete sentences
  private transcriptBuffer: string[] = []
  private bufferTimeout: ReturnType<typeof setTimeout> | null = null
  private bufferStartTime: number = 0
  private readonly BUFFER_DELAY_MS = 1000
  private readonly MAX_BUFFER_TIME_MS = 3000 // Force flush after 3s max

  constructor(config: TwitchAudioCaptureConfig) {
    this.config = {
      chunkDurationSeconds: 8,
      quality: "audio_only",
      ...config,
    }
    this.openai = new OpenAI({ apiKey: config.openaiApiKey })
    this.tempDir = path.join("/tmp", "twitch-audio-chunks")
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      console.warn("[TwitchAudio] Already running")
      return
    }

    // Create temp directory
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true })
    }

    console.log(`[TwitchAudio] Starting audio capture from twitch.tv/${this.config.channel}`)
    console.log(`[TwitchAudio] Recording ${this.config.chunkDurationSeconds}s chunks`)

    this.isRunning = true
    this.recordLoop()
  }

  async stop(): Promise<void> {
    this.isRunning = false

    if (this.streamlinkProcess) {
      this.streamlinkProcess.kill()
      this.streamlinkProcess = null
    }

    if (this.ffmpegProcess) {
      this.ffmpegProcess.kill()
      this.ffmpegProcess = null
    }

    if (this.bufferTimeout) {
      clearTimeout(this.bufferTimeout)
      this.bufferTimeout = null
    }

    console.log("[TwitchAudio] Stopped")
  }

  onTranscript(handler: TranscriptHandler): void {
    this.handlers.push(handler)
  }

  private async recordLoop(): Promise<void> {
    while (this.isRunning) {
      const chunkFile = path.join(this.tempDir, `chunk-${this.chunkIndex++}.wav`)

      try {
        await this.recordChunk(chunkFile)

        if (!this.isRunning) break

        // Check if file exists and has content
        if (fs.existsSync(chunkFile)) {
          const stats = fs.statSync(chunkFile)
          if (stats.size > 1000) {
            // Transcribe in background
            this.transcribeChunk(chunkFile).catch((err) => {
              console.error("[TwitchAudio] Transcription error:", err)
            })
          } else {
            fs.unlinkSync(chunkFile)
          }
        }
      } catch (err) {
        console.error("[TwitchAudio] Recording error:", err)
        await this.sleep(2000)
      }
    }
  }

  private recordChunk(outputFile: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const streamUrl = `https://twitch.tv/${this.config.channel}`

      // Use streamlink to get audio stream, pipe to ffmpeg
      const streamlinkArgs = [
        streamUrl,
        this.config.quality!,
        "--stdout",
        "--quiet",
      ]

      const ffmpegArgs = [
        "-i", "pipe:0",
        "-t", String(this.config.chunkDurationSeconds),
        "-ar", "16000",     // 16kHz sample rate (good for speech)
        "-ac", "1",         // Mono
        "-f", "wav",
        "-y",
        outputFile,
      ]

      this.streamlinkProcess = spawn("streamlink", streamlinkArgs, {
        stdio: ["ignore", "pipe", "pipe"],
      })

      this.ffmpegProcess = spawn("ffmpeg", ffmpegArgs, {
        stdio: [this.streamlinkProcess.stdout, "pipe", "pipe"],
      })

      let stderr = ""
      this.ffmpegProcess.stderr?.on("data", (data) => {
        stderr += data.toString()
      })

      // Timeout slightly longer than chunk duration
      const timeout = setTimeout(() => {
        this.streamlinkProcess?.kill()
        this.ffmpegProcess?.kill()
        resolve() // Don't reject on timeout, just move on
      }, (this.config.chunkDurationSeconds! + 5) * 1000)

      this.ffmpegProcess.on("close", (code) => {
        clearTimeout(timeout)
        this.streamlinkProcess?.kill()

        if (code === 0 || code === null) {
          resolve()
        } else {
          // Don't reject - stream might be offline
          console.warn(`[TwitchAudio] ffmpeg exited with code ${code}`)
          resolve()
        }
      })

      this.ffmpegProcess.on("error", (err) => {
        clearTimeout(timeout)
        this.streamlinkProcess?.kill()
        reject(err)
      })

      this.streamlinkProcess.on("error", (err) => {
        clearTimeout(timeout)
        this.ffmpegProcess?.kill()
        reject(err)
      })
    })
  }

  private async transcribeChunk(audioFile: string): Promise<void> {
    try {
      const audioStream = fs.createReadStream(audioFile)

      const response = await this.openai.audio.transcriptions.create({
        file: audioStream,
        model: "whisper-1",
        language: "en",
        response_format: "text",
      })

      const text = (response as unknown as string).trim()

      // Clean up the audio file
      fs.unlinkSync(audioFile)

      // Filter hallucinations (same as AudioTranscriber)
      if (this.isValidTranscript(text)) {
        console.log(`[TwitchAudio] Transcribed: "${text}" (buffering...)`)
        this.addToBuffer(text)
      } else if (text.length > 0) {
        console.log(`[TwitchAudio] Filtered: "${text}"`)
      }
    } catch (err) {
      if (fs.existsSync(audioFile)) {
        fs.unlinkSync(audioFile)
      }
      throw err
    }
  }

  private isValidTranscript(text: string): boolean {
    const trimmed = text.trim()
    if (trimmed.length === 0) return false

    // Minimal filter - only the most obvious Whisper hallucinations
    const lowerText = trimmed.toLowerCase()
    const obviousHallucinations = [
      "thanks for watching",
      "thank you for watching",
      "subscribe",
      "like and subscribe",
    ]
    if (obviousHallucinations.some(h => lowerText.includes(h))) {
      console.log(`[TwitchAudio] Filtered obvious hallucination: "${trimmed}"`)
      return false
    }

    return true
  }

  private addToBuffer(text: string): void {
    // Track when buffer started filling
    if (this.transcriptBuffer.length === 0) {
      this.bufferStartTime = Date.now()
    }

    this.transcriptBuffer.push(text)

    // Force flush if buffer has been filling too long
    const bufferAge = Date.now() - this.bufferStartTime
    if (bufferAge >= this.MAX_BUFFER_TIME_MS) {
      this.flushBuffer()
      return
    }

    if (this.bufferTimeout) {
      clearTimeout(this.bufferTimeout)
    }

    this.bufferTimeout = setTimeout(() => {
      this.flushBuffer()
    }, this.BUFFER_DELAY_MS)
  }

  private flushBuffer(): void {
    if (this.transcriptBuffer.length === 0) return

    const combinedText = this.transcriptBuffer.join(" ").trim()
    this.transcriptBuffer = []
    this.bufferTimeout = null

    if (combinedText.length > 0) {
      console.log(`[TwitchAudio] Broadcasting: "${combinedText}"`)

      const transcript: TranscriptMessage = {
        text: combinedText,
        timestamp: Date.now(),
      }

      for (const handler of this.handlers) {
        handler(transcript)
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}

export default TwitchAudioCapture
