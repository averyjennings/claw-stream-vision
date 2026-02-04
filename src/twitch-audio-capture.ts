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
  private readonly BUFFER_DELAY_MS = 2500

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
    const lowerText = text.toLowerCase()

    // Hallucination patterns
    const hallucinations = [
      "thanks for watching", "thank you for watching", "thank you so much for watching",
      "hope you enjoyed", "i hope you enjoyed", "see you next time", "see you in the next",
      "next video", "bye", "take care", "subscribe", "like and subscribe",
      "hit the bell", "notification", "please see the complete disclaimer",
      "www.", "http", ".com", "copyright", "all rights reserved",
      "transcript by", "subtitles by", "captions by",
      "finish the sentence", "complete the sentence", "please complete",
      "music", "applause", "silence", "♪",
    ]

    if (hallucinations.some(h => lowerText.includes(h))) {
      return false
    }

    // Too short
    if (text.length < 3 || text.replace(/[^a-zA-Z]/g, "").length < 2) {
      return false
    }

    // Single common word
    const singleWordHallucinations = [
      "you", "the", "a", "i", "and", "to", "it", "is", "that", "this",
      "for", "on", "are", "as", "with", "they", "be", "at", "one", "have",
      "do", "we", "me", "he", "she", "so", "no", "yes", "oh", "um", "uh",
    ]
    const words = lowerText.trim().split(/\s+/)
    if (words.length === 1 && singleWordHallucinations.includes(words[0].replace(/[^a-z]/g, ""))) {
      return false
    }

    return true
  }

  private addToBuffer(text: string): void {
    this.transcriptBuffer.push(text)

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
