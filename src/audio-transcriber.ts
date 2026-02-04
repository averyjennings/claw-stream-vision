/**
 * Audio Transcription Service
 * Captures microphone audio and transcribes using OpenAI Whisper API
 */

import { spawn, type ChildProcess } from "child_process"
import * as fs from "fs"
import * as path from "path"
import OpenAI from "openai"

export interface TranscriptMessage {
  text: string
  timestamp: number
}

export interface AudioTranscriberConfig {
  openaiApiKey: string
  chunkDurationSeconds?: number // How long each audio chunk is (default: 5s)
  silenceThreshold?: number // Minimum audio level to trigger transcription
}

type TranscriptHandler = (transcript: TranscriptMessage) => void

export class AudioTranscriber {
  private config: AudioTranscriberConfig
  private openai: OpenAI
  private recordingProcess: ChildProcess | null = null
  private isRunning = false
  private handlers: TranscriptHandler[] = []
  private tempDir: string
  private chunkIndex = 0

  // Buffer for combining incomplete sentences
  private transcriptBuffer: string[] = []
  private bufferTimeout: ReturnType<typeof setTimeout> | null = null
  private readonly BUFFER_DELAY_MS = 2500 // Wait 2.5s for more text before broadcasting

  constructor(config: AudioTranscriberConfig) {
    this.config = {
      chunkDurationSeconds: 5,
      silenceThreshold: 0.01,
      ...config,
    }
    this.openai = new OpenAI({ apiKey: config.openaiApiKey })
    this.tempDir = path.join("/tmp", "claw-audio-chunks")
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      console.warn("[Audio] Already running")
      return
    }

    // Create temp directory for audio chunks
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true })
    }

    this.isRunning = true
    console.log("[Audio] Starting microphone capture...")
    console.log(`[Audio] Recording ${this.config.chunkDurationSeconds}s chunks`)

    this.recordLoop()
  }

  async stop(): Promise<void> {
    this.isRunning = false
    if (this.recordingProcess) {
      this.recordingProcess.kill()
      this.recordingProcess = null
    }
    console.log("[Audio] Stopped")
  }

  onTranscript(handler: TranscriptHandler): void {
    this.handlers.push(handler)
  }

  private async recordLoop(): Promise<void> {
    while (this.isRunning) {
      const chunkFile = path.join(this.tempDir, `chunk-${this.chunkIndex++}.wav`)

      try {
        // Record audio chunk using sox
        await this.recordChunk(chunkFile)

        if (!this.isRunning) break

        // Check if file exists and has content
        if (!fs.existsSync(chunkFile)) {
          continue // Sox didn't create the file, skip this chunk
        }
        const stats = fs.statSync(chunkFile)
        if (stats.size > 1000) { // More than 1KB means recording succeeded
          // Transcribe in background (don't block next recording)
          this.transcribeChunk(chunkFile).catch((err) => {
            console.error("[Audio] Transcription error:", err)
          })
        } else {
          // Silent chunk, delete it
          fs.unlinkSync(chunkFile)
        }
      } catch (err) {
        console.error("[Audio] Recording error:", err)
        await this.sleep(1000)
      }
    }
  }

  private recordChunk(outputFile: string): Promise<void> {
    return new Promise((resolve, reject) => {
      // Use sox to record from default microphone
      // -d = default input device
      // -r 16000 = 16kHz sample rate (good for speech)
      // -c 1 = mono
      // -b 16 = 16-bit
      const args = [
        "-d", // default input
        "-r", "16000", // sample rate
        "-c", "1", // mono
        "-b", "16", // bit depth
        outputFile,
        "trim", "0", String(this.config.chunkDurationSeconds),
        // No silence detection - let Whisper handle quiet audio
      ]

      this.recordingProcess = spawn("sox", args, {
        stdio: ["ignore", "pipe", "pipe"],
      })

      let stderr = ""
      this.recordingProcess.stderr?.on("data", (data) => {
        stderr += data.toString()
      })

      this.recordingProcess.on("close", (code) => {
        this.recordingProcess = null
        if (code === 0 || code === null) {
          resolve()
        } else {
          reject(new Error(`sox exited with code ${code}: ${stderr}`))
        }
      })

      this.recordingProcess.on("error", (err) => {
        this.recordingProcess = null
        reject(err)
      })

      // Force stop after max duration + buffer
      setTimeout(() => {
        if (this.recordingProcess) {
          this.recordingProcess.kill("SIGTERM")
        }
      }, (this.config.chunkDurationSeconds! + 1) * 1000)
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

      // Filter out common Whisper hallucinations (happens during silence)
      // These are patterns Whisper learned from YouTube videos
      const hallucinations = [
        // YouTube outro patterns (most common hallucination!)
        "thanks for watching",
        "thank you for watching",
        "thank you so much for watching",
        "hope you enjoyed",
        "i hope you enjoyed",
        "see you next time",
        "see you in the next",
        "see you in my next",
        "i'll see you",
        "next video",
        "next time",
        "bye",  // catches "bye", "bye!", "goodbye", etc.
        "take care",
        // Subscription prompts
        "subscribe",
        "like and subscribe",
        "don't forget to subscribe",
        "hit the bell",
        "notification",
        // Disclaimers and credits
        "please see the complete disclaimer",
        "sites.google.com",
        "www.",
        "http",
        ".com",
        "copyright",
        "all rights reserved",
        "transcript by",
        "subtitles by",
        "captions by",
        // Incomplete sentence prompts
        "finish the sentence",
        "complete the sentence",
        "please complete",
        // Music/silence fillers
        "music",
        "applause",
        "silence",
        "♪",
      ]

      const lowerText = text.toLowerCase()
      const isHallucination = hallucinations.some(h => lowerText.includes(h))

      // Filter out very short or punctuation-only transcripts
      const isTooShort = text.length < 3 || text.replace(/[^a-zA-Z]/g, "").length < 2

      // Filter out single common words (Whisper hallucinates these during silence)
      const singleWordHallucinations = [
        "you", "the", "a", "i", "and", "to", "it", "is", "that", "this",
        "for", "on", "are", "as", "with", "they", "be", "at", "one", "have",
        "do", "we", "me", "he", "she", "so", "no", "yes", "oh", "um", "uh",
      ]
      const words = lowerText.trim().split(/\s+/)
      const isSingleCommonWord = words.length === 1 && singleWordHallucinations.includes(words[0].replace(/[^a-z]/g, ""))

      // Filter out very short phrases (2-3 words) that are likely hallucinations
      // e.g., "you KATHRYN", "the end", "oh yeah" - these are usually noise
      const isShortNonsense = words.length <= 3 && text.length < 20

      // Filter out phrases that start with common filler + random word (like "you KATHRYN")
      const startsWithFiller = words.length >= 1 && words.length <= 3 &&
        singleWordHallucinations.includes(words[0].replace(/[^a-z]/g, ""))

      // Combined short phrase filter
      const isLikelyShortHallucination = isShortNonsense && startsWithFiller

      if (text && text.length > 0 && !isHallucination && !isTooShort && !isSingleCommonWord && !isLikelyShortHallucination) {
        console.log(`[Audio] Transcribed: "${text}" (buffering...)`)
        this.addToBuffer(text)
      } else if (isHallucination || isSingleCommonWord || isLikelyShortHallucination) {
        console.log(`[Audio] Filtered hallucination: "${text}"`)
      }
    } catch (err) {
      // Clean up on error too
      if (fs.existsSync(audioFile)) {
        fs.unlinkSync(audioFile)
      }
      throw err
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  /**
   * Add transcript to buffer and reset the flush timer.
   * This combines consecutive chunks into complete sentences.
   */
  private addToBuffer(text: string): void {
    this.transcriptBuffer.push(text)

    // Clear existing timeout
    if (this.bufferTimeout) {
      clearTimeout(this.bufferTimeout)
    }

    // Set new timeout to flush buffer after delay
    this.bufferTimeout = setTimeout(() => {
      this.flushBuffer()
    }, this.BUFFER_DELAY_MS)
  }

  /**
   * Flush the buffer - combine all text and broadcast as one transcript
   */
  private flushBuffer(): void {
    if (this.transcriptBuffer.length === 0) return

    // Combine all buffered transcripts into one
    const combinedText = this.transcriptBuffer.join(" ").trim()
    this.transcriptBuffer = []
    this.bufferTimeout = null

    if (combinedText.length > 0) {
      console.log(`[Audio] Broadcasting combined: "${combinedText}"`)

      const transcript: TranscriptMessage = {
        text: combinedText,
        timestamp: Date.now(),
      }

      for (const handler of this.handlers) {
        handler(transcript)
      }
    }
  }
}
