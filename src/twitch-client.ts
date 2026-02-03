import tmi from "tmi.js"
import type { TwitchConfig, ChatMessage } from "./types.js"

type MessageHandler = (message: ChatMessage) => void

export class TwitchClient {
  private client: tmi.Client
  private config: TwitchConfig
  private connected = false
  private messageHandlers: MessageHandler[] = []

  constructor(config: TwitchConfig) {
    this.config = config
    this.client = new tmi.Client({
      options: { debug: false },
      identity: {
        username: config.username,
        password: config.oauthToken,
      },
      channels: [config.channel],
    })

    this.setupEventHandlers()
  }

  private setupEventHandlers(): void {
    this.client.on("message", (channel, tags, message, self) => {
      // Don't echo back our own messages
      if (self) return

      // Convert badges from tmi.js format (string | undefined values) to string values
      const badges: Record<string, string> = {}
      if (tags.badges) {
        for (const [key, value] of Object.entries(tags.badges)) {
          if (value !== undefined) {
            badges[key] = value
          }
        }
      }

      const chatMessage: ChatMessage = {
        timestamp: Date.now(),
        username: tags.username ?? "anonymous",
        displayName: tags["display-name"] ?? tags.username ?? "Anonymous",
        message,
        channel: channel.replace("#", ""),
        isMod: tags.mod ?? false,
        isSubscriber: tags.subscriber ?? false,
        badges,
      }

      for (const handler of this.messageHandlers) {
        handler(chatMessage)
      }
    })

    this.client.on("connected", () => {
      console.log(`[Twitch] Connected to #${this.config.channel}`)
      this.connected = true
    })

    this.client.on("disconnected", (reason) => {
      console.log(`[Twitch] Disconnected: ${reason}`)
      this.connected = false
    })
  }

  async connect(): Promise<void> {
    console.log(`[Twitch] Connecting to #${this.config.channel}...`)
    await this.client.connect()
  }

  async disconnect(): Promise<void> {
    if (this.connected) {
      await this.client.disconnect()
      this.connected = false
      console.log("[Twitch] Disconnected")
    }
  }

  isConnected(): boolean {
    return this.connected
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandlers.push(handler)
  }

  async sendMessage(message: string): Promise<void> {
    if (!this.connected) {
      console.warn("[Twitch] Not connected, cannot send message")
      return
    }

    await this.client.say(this.config.channel, message)
  }

  async sendClawMessage(clawName: string, message: string): Promise<void> {
    // Format claw messages with a distinctive prefix
    const formattedMessage = `🦀 [${clawName}]: ${message}`
    await this.sendMessage(formattedMessage)
  }
}
