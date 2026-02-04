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
      // Two-step approach: streamlink writes to temp file, ffmpeg extracts frame
      const tempVideo = path.join(this.tempDir, `temp-${Date.now()}.ts`)

      // Step 1: Get a few seconds of video with streamlink
      const streamlinkArgs = [
        streamUrl,
        this.config.quality!,
        "-o", tempVideo,
        "--stream-segmented-duration", "3s", // Get 3 seconds of video
        "--quiet",
      ]

      const streamlink = spawn("streamlink", streamlinkArgs, {
        stdio: ["ignore", "pipe", "pipe"],
      })

      const timeout = setTimeout(() => {
        streamlink.kill("SIGKILL")
        // Try to extract frame anyway if we got partial data
        this.extractFrame(tempVideo, outputFile).then(resolve).catch(reject)
      }, 15000)

      streamlink.on("close", () => {
        clearTimeout(timeout)

        // Step 2: Extract frame with ffmpeg
        this.extractFrame(tempVideo, outputFile)
          .then(resolve)
          .catch(reject)
          .finally(() => {
            // Clean up temp video
            if (fs.existsSync(tempVideo)) {
              fs.unlinkSync(tempVideo)
            }
          })
      })

      streamlink.on("error", (err) => {
        clearTimeout(timeout)
        if (fs.existsSync(tempVideo)) {
          fs.unlinkSync(tempVideo)
        }
        reject(err)
      })
    })
  }

  private extractFrame(inputFile: string, outputFile: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!fs.existsSync(inputFile)) {
        reject(new Error("Input video file not found"))
        return
      }

      const ffmpegArgs = [
        "-i", inputFile,
        "-vframes", "1",
        "-s", `${this.config.width}x${this.config.height}`,
        "-update", "1", // Write single image without sequence pattern
        "-y",
        outputFile,
      ]

      const ffmpeg = spawn("ffmpeg", ffmpegArgs, {
        stdio: ["ignore", "pipe", "pipe"],
      })

      let stderr = ""
      ffmpeg.stderr?.on("data", (data) => {
        stderr += data.toString()
      })

      ffmpeg.on("close", (code) => {
        if (code === 0 && fs.existsSync(outputFile)) {
          resolve()
        } else {
          reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-500)}`))
        }
      })

      ffmpeg.on("error", reject)
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
