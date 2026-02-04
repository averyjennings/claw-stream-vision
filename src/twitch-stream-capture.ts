/**
 * Twitch Stream Capture
 * Captures frames and audio directly from a Twitch stream using streamlink + ffmpeg
 * Used for "headless" mode when OBS isn't available (e.g., mobile streaming)
 */

import { spawn, type ChildProcess } from "child_process"
import * as fs from "fs"
import * as path from "path"
import type { StreamFrame } from "./types.js"

export interface TwitchStreamCaptureConfig {
  channel: string
  screenshotIntervalMs?: number
  width?: number
  height?: number
  format?: "png" | "jpg"
  quality?: string // e.g., "720p", "480p", "best", "worst"
}

type FrameHandler = (frame: StreamFrame) => void

export class TwitchStreamCapture {
  private config: TwitchStreamCaptureConfig
  private isRunning = false
  private frameHandlers: FrameHandler[] = []
  private captureProcess: ChildProcess | null = null
  private captureInterval: ReturnType<typeof setInterval> | null = null
  private tempDir: string
  private frameIndex = 0

  constructor(config: TwitchStreamCaptureConfig) {
    this.config = {
      screenshotIntervalMs: 5000,
      width: 1280,
      height: 720,
      format: "png",
      quality: "720p",
      ...config,
    }
    this.tempDir = path.join("/tmp", "twitch-capture")
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      console.warn("[TwitchCapture] Already running")
      return
    }

    // Create temp directory
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true })
    }

    console.log(`[TwitchCapture] Starting capture from twitch.tv/${this.config.channel}`)
    console.log(`[TwitchCapture] Quality: ${this.config.quality}, Interval: ${this.config.screenshotIntervalMs}ms`)

    this.isRunning = true

    // Start the capture loop
    this.captureLoop()
  }

  async stop(): Promise<void> {
    this.isRunning = false

    if (this.captureInterval) {
      clearInterval(this.captureInterval)
      this.captureInterval = null
    }

    if (this.captureProcess) {
      this.captureProcess.kill()
      this.captureProcess = null
    }

    console.log("[TwitchCapture] Stopped")
  }

  onFrame(handler: FrameHandler): void {
    this.frameHandlers.push(handler)
  }

  private async captureLoop(): Promise<void> {
    // Capture first frame immediately
    await this.captureFrame()

    // Then capture at interval
    this.captureInterval = setInterval(async () => {
      if (this.isRunning) {
        await this.captureFrame()
      }
    }, this.config.screenshotIntervalMs)
  }

  private async captureFrame(): Promise<void> {
    const outputFile = path.join(this.tempDir, `frame-${this.frameIndex++}.${this.config.format}`)

    try {
      // Use streamlink + ffmpeg pipeline to capture a single frame
      // streamlink gets the stream URL, ffmpeg captures one frame
      const streamUrl = `https://twitch.tv/${this.config.channel}`

      await this.captureWithStreamlink(streamUrl, outputFile)

      // Read the captured frame
      if (fs.existsSync(outputFile)) {
        const imageBuffer = fs.readFileSync(outputFile)
        const imageBase64 = imageBuffer.toString("base64")

        // Clean up temp file
        fs.unlinkSync(outputFile)

        const frame: StreamFrame = {
          timestamp: Date.now(),
          imageBase64,
          format: this.config.format!,
          width: this.config.width!,
          height: this.config.height!,
        }

        // Broadcast to handlers
        for (const handler of this.frameHandlers) {
          handler(frame)
        }

        console.log(`[TwitchCapture] Captured frame at ${new Date().toISOString()}`)
      } else {
        console.warn("[TwitchCapture] Frame capture failed - file not created")
      }
    } catch (err) {
      console.error("[TwitchCapture] Error capturing frame:", err)
      // Clean up on error
      if (fs.existsSync(outputFile)) {
        fs.unlinkSync(outputFile)
      }
    }
  }

  private captureWithStreamlink(streamUrl: string, outputFile: string): Promise<void> {
    return new Promise((resolve, reject) => {
      // streamlink pipes to ffmpeg which captures a single frame
      // This is more reliable than trying to maintain a persistent connection

      const streamlinkArgs = [
        streamUrl,
        this.config.quality!,
        "--stdout",        // Output to stdout
        "--quiet",         // Less verbose
      ]

      const ffmpegArgs = [
        "-i", "pipe:0",    // Read from stdin (streamlink output)
        "-vframes", "1",   // Capture just 1 frame
        "-s", `${this.config.width}x${this.config.height}`,
        "-y",              // Overwrite output
        outputFile,
      ]

      // Spawn streamlink
      const streamlink = spawn("streamlink", streamlinkArgs, {
        stdio: ["ignore", "pipe", "pipe"],
      })

      // Spawn ffmpeg, pipe streamlink output to it
      const ffmpeg = spawn("ffmpeg", ffmpegArgs, {
        stdio: [streamlink.stdout, "pipe", "pipe"],
      })

      let stderr = ""
      ffmpeg.stderr?.on("data", (data) => {
        stderr += data.toString()
      })

      // Set timeout to avoid hanging
      const timeout = setTimeout(() => {
        streamlink.kill()
        ffmpeg.kill()
        reject(new Error("Capture timed out after 30s"))
      }, 30000)

      ffmpeg.on("close", (code) => {
        clearTimeout(timeout)
        streamlink.kill() // Ensure streamlink is killed

        if (code === 0) {
          resolve()
        } else {
          reject(new Error(`ffmpeg exited with code ${code}: ${stderr}`))
        }
      })

      ffmpeg.on("error", (err) => {
        clearTimeout(timeout)
        streamlink.kill()
        reject(err)
      })

      streamlink.on("error", (err) => {
        clearTimeout(timeout)
        ffmpeg.kill()
        reject(err)
      })
    })
  }

  /**
   * Check if the stream is live
   */
  async isStreamLive(): Promise<boolean> {
    return new Promise((resolve) => {
      const streamlink = spawn("streamlink", [
        `https://twitch.tv/${this.config.channel}`,
        "--json",
      ], {
        stdio: ["ignore", "pipe", "pipe"],
      })

      let stdout = ""
      streamlink.stdout?.on("data", (data) => {
        stdout += data.toString()
      })

      streamlink.on("close", (code) => {
        if (code === 0) {
          try {
            const info = JSON.parse(stdout)
            resolve(!!info.streams && Object.keys(info.streams).length > 0)
          } catch {
            resolve(false)
          }
        } else {
          resolve(false)
        }
      })

      streamlink.on("error", () => {
        resolve(false)
      })

      // Timeout after 10s
      setTimeout(() => {
        streamlink.kill()
        resolve(false)
      }, 10000)
    })
  }
}

export default TwitchStreamCapture
