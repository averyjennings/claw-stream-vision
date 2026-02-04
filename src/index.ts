import { loadConfig } from "./config.js"
import { OBSClient } from "./obs-client.js"
import { TwitchClient } from "./twitch-client.js"
import { VisionBroadcaster } from "./vision-broadcaster.js"
import { AudioTranscriber } from "./audio-transcriber.js"
import { TwitchStreamCapture } from "./twitch-stream-capture.js"
import { TwitchAudioCapture } from "./twitch-audio-capture.js"
import type { ClawMessage } from "./types.js"

async function main(): Promise<void> {
  console.log("🦀 Claw Stream Vision - Starting up...")
  console.log("============================================")

  const config = loadConfig()

  console.log(`[Main] Capture mode: ${config.captureMode.toUpperCase()}`)

  // Initialize common components
  const twitchClient = new TwitchClient(config.twitch)
  const broadcaster = new VisionBroadcaster(config.server)

  // Start the vision broadcaster server
  await broadcaster.start()

  // Connect to Twitch chat (always needed for chat functionality)
  await twitchClient.connect().catch((err: unknown) => {
    console.error("[Main] Failed to connect to Twitch:", err)
    console.log("[Main] Continuing without Twitch - chat will be unavailable")
  })

  // Wire up Twitch chat to broadcaster
  twitchClient.onMessage((message) => {
    broadcaster.broadcastChatMessage(message)
    console.log(`[Chat] ${message.displayName}: ${message.message}`)
  })

  // Wire up claw messages to Twitch chat
  broadcaster.onClawMessage(async (clawMessage: ClawMessage) => {
    if (clawMessage.type === "chat") {
      await twitchClient.sendClawMessage(clawMessage.clawName, clawMessage.content)
      console.log(`[Claw Chat] ${clawMessage.clawName}: ${clawMessage.content}`)
    } else if (clawMessage.type === "observation") {
      console.log(`[Claw Observation] ${clawMessage.clawName}: ${clawMessage.content}`)
    } else if (clawMessage.type === "reaction") {
      console.log(`[Claw Reaction] ${clawMessage.clawName}: ${clawMessage.content}`)
    }
  })

  // Mode-specific setup
  let obsClient: OBSClient | null = null
  let twitchCapture: TwitchStreamCapture | null = null
  let audioTranscriber: AudioTranscriber | null = null
  let twitchAudioCapture: TwitchAudioCapture | null = null
  let screenshotInterval: ReturnType<typeof setInterval> | null = null

  if (config.captureMode === "obs") {
    // ========== OBS MODE ==========
    // Captures frames from OBS, audio from local microphone
    console.log("[Main] Using OBS mode - capturing from OBS WebSocket + local microphone")

    obsClient = new OBSClient(config.obs, config.vision)

    await obsClient.connect().catch((err: unknown) => {
      console.error("[Main] Failed to connect to OBS:", err)
      console.log("[Main] Continuing without OBS - screenshots will be unavailable")
    })

    if (obsClient.isConnected()) {
      console.log(
        `[Main] Starting screenshot capture every ${config.vision.screenshotIntervalMs}ms`
      )

      const streamStatus = await obsClient.getStreamStatus()
      if (streamStatus) {
        broadcaster.setStreamLive(streamStatus.isStreaming)
      }

      screenshotInterval = setInterval(async () => {
        const frame = await obsClient!.captureScreenshot()
        if (frame) {
          broadcaster.broadcastFrame(frame)
          const clawCount = broadcaster.getConnectedClaws().length
          console.log(
            `[Vision] Captured frame at ${new Date(frame.timestamp).toISOString()} - Broadcasting to ${clawCount} claws`
          )
        }
      }, config.vision.screenshotIntervalMs)
    }

    // Audio from local microphone
    if (config.audio.enabled && config.audio.openaiApiKey && config.audio.openaiApiKey !== "your-openai-api-key-here") {
      console.log("[Main] Starting audio transcription from local microphone...")
      audioTranscriber = new AudioTranscriber({
        openaiApiKey: config.audio.openaiApiKey,
        chunkDurationSeconds: config.audio.chunkDurationSeconds,
      })

      audioTranscriber.onTranscript((transcript) => {
        broadcaster.broadcastTranscript(transcript)
        console.log(`[Vision] Broadcasting transcript to ${broadcaster.getConnectedClaws().length} claws: "${transcript.text}"`)
      })

      await audioTranscriber.start().catch((err: unknown) => {
        console.error("[Main] Failed to start audio transcription:", err)
        audioTranscriber = null
      })
    }

  } else {
    // ========== TWITCH MODE ==========
    // Captures frames and audio directly from the Twitch stream
    // Used for mobile streaming (no OBS, no local mic)
    console.log("[Main] Using TWITCH mode - capturing from Twitch stream")
    console.log(`[Main] Watching stream: twitch.tv/${config.twitch.channel}`)

    // Frame capture from Twitch
    twitchCapture = new TwitchStreamCapture({
      channel: config.twitch.channel,
      screenshotIntervalMs: config.vision.screenshotIntervalMs,
      width: config.vision.screenshotWidth,
      height: config.vision.screenshotHeight,
      format: config.vision.screenshotFormat === "webp" ? "png" : config.vision.screenshotFormat,
      quality: config.twitch.streamQuality ?? "720p",
    })

    twitchCapture.onFrame((frame) => {
      broadcaster.broadcastFrame(frame)
      const clawCount = broadcaster.getConnectedClaws().length
      console.log(
        `[Vision] Captured frame at ${new Date(frame.timestamp).toISOString()} - Broadcasting to ${clawCount} claws`
      )
    })

    // Check if stream is live before starting
    const isLive = await twitchCapture.isStreamLive()
    if (isLive) {
      console.log(`[Main] Stream is LIVE! Starting capture...`)
      broadcaster.setStreamLive(true)
      await twitchCapture.start()
    } else {
      console.log(`[Main] Stream is OFFLINE. Waiting for stream to go live...`)
      broadcaster.setStreamLive(false)

      // Poll for stream to go live
      const pollInterval = setInterval(async () => {
        const nowLive = await twitchCapture!.isStreamLive()
        if (nowLive) {
          console.log(`[Main] Stream is now LIVE! Starting capture...`)
          broadcaster.setStreamLive(true)
          clearInterval(pollInterval)
          await twitchCapture!.start()

          // Also start audio capture if configured
          if (twitchAudioCapture) {
            console.log(`[Main] Starting audio transcription...`)
            await twitchAudioCapture.start().catch((err: unknown) => {
              console.error("[Main] Failed to start Twitch audio capture:", err)
            })
          }
        }
      }, 30000) // Check every 30 seconds
    }

    // Audio from Twitch stream
    if (config.audio.enabled && config.audio.openaiApiKey && config.audio.openaiApiKey !== "your-openai-api-key-here") {
      console.log("[Main] Starting audio transcription from Twitch stream...")
      twitchAudioCapture = new TwitchAudioCapture({
        channel: config.twitch.channel,
        openaiApiKey: config.audio.openaiApiKey,
        quality: "audio_only",
      })

      twitchAudioCapture.onTranscript((transcript) => {
        broadcaster.broadcastTranscript(transcript)
        console.log(`[Vision] Broadcasting transcript to ${broadcaster.getConnectedClaws().length} claws: "${transcript.text}"`)
      })

      // Only start audio capture if stream is live
      if (isLive) {
        await twitchAudioCapture.start().catch((err: unknown) => {
          console.error("[Main] Failed to start Twitch audio capture:", err)
          twitchAudioCapture = null
        })
      }
    }
  }

  // Graceful shutdown
  const shutdown = async (): Promise<void> => {
    console.log("\n[Main] Shutting down...")

    if (screenshotInterval) {
      clearInterval(screenshotInterval)
    }

    await Promise.all([
      obsClient?.disconnect(),
      twitchCapture?.stop(),
      audioTranscriber?.stop(),
      twitchAudioCapture?.stop(),
      twitchClient.disconnect(),
      broadcaster.stop(),
    ])

    console.log("[Main] Goodbye! 🦀")
    process.exit(0)
  }

  process.on("SIGINT", () => void shutdown())
  process.on("SIGTERM", () => void shutdown())

  const audioStatus = audioTranscriber ?? twitchAudioCapture ? "✅ Active" : "❌ Disabled"

  console.log("============================================")
  console.log("🦀 Claw Stream Vision is running!")
  console.log(`   Mode: ${config.captureMode.toUpperCase()}`)
  console.log(`   Vision Server: http://localhost:${config.server.port}`)
  console.log(`   WebSocket: ws://localhost:${config.server.port}`)
  console.log(`   Twitch Channel: #${config.twitch.channel}`)
  console.log(`   Speech-to-Text: ${audioStatus}`)
  console.log("============================================")
  console.log("Press Ctrl+C to stop\n")
}

main().catch((err: unknown) => {
  console.error("Fatal error:", err)
  process.exit(1)
})
