import { WebSocket, WebSocketServer } from "ws"
import express from "express"
import type { Server } from "http"
import type {
  StreamFrame,
  ChatMessage,
  ClawParticipant,
  StreamState,
  VisionBroadcast,
  ClawMessage,
  ServerConfig,
  TranscriptMessage,
} from "./types.js"

interface ConnectedClaw {
  ws: WebSocket
  participant: ClawParticipant
}

type ClawMessageHandler = (message: ClawMessage) => void

export class VisionBroadcaster {
  private wss: WebSocketServer | null = null
  private server: Server | null = null
  private connectedClaws: Map<string, ConnectedClaw> = new Map()
  private recentChat: ChatMessage[] = []
  private currentFrame: StreamFrame | null = null
  private streamStartedAt: number | null = null
  private clawMessageHandlers: ClawMessageHandler[] = []
  private config: ServerConfig
  private maxChatHistory = 100

  constructor(config: ServerConfig) {
    this.config = config
  }

  async start(): Promise<void> {
    const app = express()
    app.use(express.json())

    // Health check endpoint
    app.get("/health", (_req, res) => {
      res.json({
        status: "ok",
        connectedClaws: this.connectedClaws.size,
        streamActive: this.streamStartedAt !== null,
      })
    })

    // Current state endpoint (for HTTP polling if WebSocket unavailable)
    app.get("/state", (_req, res) => {
      res.json(this.getStreamState())
    })

    // Latest frame endpoint
    app.get("/frame", (_req, res) => {
      if (this.currentFrame) {
        res.json(this.currentFrame)
      } else {
        res.status(404).json({ error: "No frame available" })
      }
    })

    // Recent chat endpoint
    app.get("/chat", (_req, res) => {
      res.json(this.recentChat)
    })

    this.server = app.listen(this.config.port, () => {
      console.log(`[Vision] HTTP server listening on port ${this.config.port}`)
    })

    this.wss = new WebSocketServer({ server: this.server })

    this.wss.on("connection", (ws) => {
      console.log("[Vision] New WebSocket connection")

      ws.on("message", (data) => {
        this.handleClawMessage(ws, data.toString())
      })

      ws.on("close", () => {
        this.handleClawDisconnect(ws)
      })

      ws.on("error", (err) => {
        console.error("[Vision] WebSocket error:", err)
      })

      // Send current state to newly connected claw
      const stateMessage: VisionBroadcast = {
        type: "state",
        payload: this.getStreamState(),
        timestamp: Date.now(),
      }
      ws.send(JSON.stringify(stateMessage))
    })

    console.log(`[Vision] WebSocket server listening on port ${this.config.port}`)
  }

  async stop(): Promise<void> {
    if (this.wss) {
      this.wss.close()
      this.wss = null
    }
    if (this.server) {
      this.server.close()
      this.server = null
    }
    console.log("[Vision] Server stopped")
  }

  private handleClawMessage(ws: WebSocket, rawMessage: string): void {
    let message: {
      type: string
      clawId?: string
      clawName?: string
      sessionId?: string
      content?: string
      messageType?: string
    }

    try {
      message = JSON.parse(rawMessage) as typeof message
    } catch {
      console.error("[Vision] Invalid JSON message:", rawMessage)
      return
    }

    switch (message.type) {
      case "register": {
        // Claw is registering itself
        if (!message.clawId || !message.clawName) {
          console.warn("[Vision] Invalid registration message")
          return
        }

        const participant: ClawParticipant = {
          id: message.clawId,
          name: message.clawName,
          sessionId: message.sessionId ?? "",
          joinedAt: Date.now(),
          lastSeen: Date.now(),
        }

        this.connectedClaws.set(message.clawId, { ws, participant })
        console.log(`[Vision] Claw registered: ${message.clawName} (${message.clawId})`)

        // Notify all claws of the new participant
        this.broadcastState()
        break
      }

      case "chat":
      case "reaction":
      case "observation": {
        // Claw is sending a message
        const clawMessage: ClawMessage = {
          type: message.type as "chat" | "reaction" | "observation",
          content: message.content ?? "",
          clawId: message.clawId ?? "",
          clawName: message.clawName ?? "Unknown Claw",
          timestamp: Date.now(),
        }

        for (const handler of this.clawMessageHandlers) {
          handler(clawMessage)
        }
        break
      }

      case "ping": {
        // Keep-alive ping
        const claw = Array.from(this.connectedClaws.values()).find(
          (c) => c.ws === ws
        )
        if (claw) {
          claw.participant.lastSeen = Date.now()
        }
        ws.send(JSON.stringify({ type: "pong", timestamp: Date.now() }))
        break
      }

      default:
        console.warn(`[Vision] Unknown message type: ${message.type}`)
    }
  }

  private handleClawDisconnect(ws: WebSocket): void {
    for (const [id, claw] of this.connectedClaws.entries()) {
      if (claw.ws === ws) {
        console.log(`[Vision] Claw disconnected: ${claw.participant.name} (${id})`)
        this.connectedClaws.delete(id)
        this.broadcastState()
        break
      }
    }
  }

  getStreamState(): StreamState {
    return {
      isLive: this.streamStartedAt !== null,
      currentFrame: this.currentFrame,
      recentChat: this.recentChat.slice(-20), // Last 20 messages
      participants: Array.from(this.connectedClaws.values()).map((c) => c.participant),
      streamStartedAt: this.streamStartedAt,
    }
  }

  setStreamLive(isLive: boolean): void {
    if (isLive && !this.streamStartedAt) {
      this.streamStartedAt = Date.now()
      console.log("[Vision] Stream started")
    } else if (!isLive && this.streamStartedAt) {
      this.streamStartedAt = null
      console.log("[Vision] Stream ended")
    }
    this.broadcastState()
  }

  broadcastFrame(frame: StreamFrame): void {
    this.currentFrame = frame

    const message: VisionBroadcast = {
      type: "frame",
      payload: frame,
      timestamp: Date.now(),
    }

    this.broadcast(message)
  }

  broadcastChatMessage(chatMessage: ChatMessage): void {
    this.recentChat.push(chatMessage)
    if (this.recentChat.length > this.maxChatHistory) {
      this.recentChat.shift()
    }

    const message: VisionBroadcast = {
      type: "chat",
      payload: chatMessage,
      timestamp: Date.now(),
    }

    this.broadcast(message)
  }

  broadcastTranscript(transcript: TranscriptMessage): void {
    const message: VisionBroadcast = {
      type: "transcript",
      payload: transcript,
      timestamp: Date.now(),
    }

    this.broadcast(message)
  }

  private broadcastState(): void {
    const message: VisionBroadcast = {
      type: "state",
      payload: this.getStreamState(),
      timestamp: Date.now(),
    }

    this.broadcast(message)
  }

  private broadcast(message: VisionBroadcast): void {
    const serialized = JSON.stringify(message)

    for (const [id, claw] of this.connectedClaws.entries()) {
      if (claw.ws.readyState === WebSocket.OPEN) {
        claw.ws.send(serialized)
      } else {
        // Clean up dead connections
        this.connectedClaws.delete(id)
      }
    }
  }

  onClawMessage(handler: ClawMessageHandler): void {
    this.clawMessageHandlers.push(handler)
  }

  getConnectedClaws(): ClawParticipant[] {
    return Array.from(this.connectedClaws.values()).map((c) => c.participant)
  }
}
