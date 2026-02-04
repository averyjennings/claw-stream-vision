import WebSocket from "ws"
import type {
  StreamFrame,
  ChatMessage,
  StreamState,
  VisionBroadcast,
  TranscriptMessage,
} from "./types.js"

interface ClawClientConfig {
  serverUrl: string
  clawId: string
  clawName: string
  sessionId?: string
}

type FrameHandler = (frame: StreamFrame) => void
type ChatHandler = (message: ChatMessage) => void
type StateHandler = (state: StreamState) => void
type TranscriptHandler = (transcript: TranscriptMessage) => void
type ReconnectHandler = () => void

/**
 * Client library for OpenClaw agents to connect to Claw Stream Vision
 *
 * Example usage:
 * ```typescript
 * const client = new ClawStreamClient({
 *   serverUrl: "ws://localhost:3847",
 *   clawId: "my-claw-123",
 *   clawName: "ClaudeBot",
 * })
 *
 * client.onFrame((frame) => {
 *   // Process the screenshot - frame.imageBase64 contains the image
 *   console.log("New frame captured at", new Date(frame.timestamp))
 * })
 *
 * client.onChat((message) => {
 *   // React to chat messages
 *   console.log(`${message.displayName}: ${message.message}`)
 * })
 *
 * await client.connect()
 *
 * // Send a message to the stream chat
 * await client.sendChat("Hello from my claw!")
 *
 * // Share an observation about what you see
 * await client.sendObservation("I see a demo of a new AI tool on screen")
 * ```
 */
export class ClawStreamClient {
  private ws: WebSocket | null = null
  private config: ClawClientConfig
  private connected = false
  private frameHandlers: FrameHandler[] = []
  private chatHandlers: ChatHandler[] = []
  private stateHandlers: StateHandler[] = []
  private transcriptHandlers: TranscriptHandler[] = []
  private reconnectHandlers: ReconnectHandler[] = []
  private reconnectAttempts = 0
  private maxReconnectAttempts = 5
  private reconnectDelay = 1000
  private pingInterval: ReturnType<typeof setInterval> | null = null

  constructor(config: ClawClientConfig) {
    this.config = config
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      console.log(`[ClawClient] Connecting to ${this.config.serverUrl}...`)

      this.ws = new WebSocket(this.config.serverUrl)

      this.ws.on("open", () => {
        const isReconnect = this.reconnectAttempts > 0
        console.log(`[ClawClient] ${isReconnect ? "Reconnected!" : "Connected!"}`)
        this.connected = true

        // Fire reconnect handlers if this was a reconnection
        if (isReconnect) {
          for (const handler of this.reconnectHandlers) {
            handler()
          }
        }
        this.reconnectAttempts = 0

        // Register ourselves
        this.send({
          type: "register",
          clawId: this.config.clawId,
          clawName: this.config.clawName,
          sessionId: this.config.sessionId,
        })

        // Start ping interval
        this.pingInterval = setInterval(() => {
          if (this.connected) {
            this.send({ type: "ping" })
          }
        }, 30000)

        resolve()
      })

      this.ws.on("message", (data) => {
        this.handleMessage(data.toString())
      })

      this.ws.on("close", () => {
        console.log("[ClawClient] Connection closed")
        this.connected = false
        if (this.pingInterval) {
          clearInterval(this.pingInterval)
          this.pingInterval = null
        }
        this.attemptReconnect()
      })

      this.ws.on("error", (err) => {
        console.error("[ClawClient] WebSocket error:", err)
        if (!this.connected) {
          reject(err)
        }
      })
    })
  }

  async disconnect(): Promise<void> {
    if (this.pingInterval) {
      clearInterval(this.pingInterval)
      this.pingInterval = null
    }
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
    this.connected = false
    console.log("[ClawClient] Disconnected")
  }

  isConnected(): boolean {
    return this.connected
  }

  private handleMessage(rawMessage: string): void {
    let message: VisionBroadcast | { type: string }

    try {
      message = JSON.parse(rawMessage) as VisionBroadcast | { type: string }
    } catch {
      console.error("[ClawClient] Invalid JSON:", rawMessage)
      return
    }

    if (message.type === "pong") {
      return // Ignore pong responses
    }

    const broadcast = message as VisionBroadcast

    switch (broadcast.type) {
      case "frame":
        for (const handler of this.frameHandlers) {
          handler(broadcast.payload as StreamFrame)
        }
        break

      case "chat":
        for (const handler of this.chatHandlers) {
          handler(broadcast.payload as ChatMessage)
        }
        break

      case "state":
        for (const handler of this.stateHandlers) {
          handler(broadcast.payload as StreamState)
        }
        break

      case "transcript":
        for (const handler of this.transcriptHandlers) {
          handler(broadcast.payload as TranscriptMessage)
        }
        break
    }
  }

  private attemptReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error("[ClawClient] Max reconnection attempts reached")
      return
    }

    this.reconnectAttempts++
    const delay = this.reconnectDelay * this.reconnectAttempts

    console.log(
      `[ClawClient] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`
    )

    setTimeout(() => {
      this.connect().catch((err: unknown) => {
        console.error("[ClawClient] Reconnection failed:", err)
      })
    }, delay)
  }

  private send(message: Record<string, unknown>): void {
    if (this.ws && this.connected) {
      this.ws.send(JSON.stringify(message))
    }
  }

  // Event handlers

  onFrame(handler: FrameHandler): void {
    this.frameHandlers.push(handler)
  }

  onChat(handler: ChatHandler): void {
    this.chatHandlers.push(handler)
  }

  onState(handler: StateHandler): void {
    this.stateHandlers.push(handler)
  }

  onTranscript(handler: TranscriptHandler): void {
    this.transcriptHandlers.push(handler)
  }

  onReconnect(handler: ReconnectHandler): void {
    this.reconnectHandlers.push(handler)
  }

  // Actions

  /**
   * Send a chat message that will appear in Twitch chat
   */
  async sendChat(content: string): Promise<void> {
    this.send({
      type: "chat",
      content,
      clawId: this.config.clawId,
      clawName: this.config.clawName,
    })
  }

  /**
   * Share an observation about what you see on stream
   * (These are logged but not sent to Twitch chat)
   */
  async sendObservation(content: string): Promise<void> {
    this.send({
      type: "observation",
      content,
      clawId: this.config.clawId,
      clawName: this.config.clawName,
    })
  }

  /**
   * Send a reaction (emoji or short expression)
   */
  async sendReaction(content: string): Promise<void> {
    this.send({
      type: "reaction",
      content,
      clawId: this.config.clawId,
      clawName: this.config.clawName,
    })
  }
}

// Export for direct usage
export default ClawStreamClient
