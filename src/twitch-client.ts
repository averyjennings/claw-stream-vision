import tmi from "tmi.js"
import type { TwitchConfig, ChatMessage } from "./types.js"

type MessageHandler = (message: ChatMessage) => void

interface TokenRefreshResponse {
  access_token: string
  refresh_token: string
  expires_in: number
  scope: string[]
  token_type: string
}

export class TwitchClient {
  private client: tmi.Client | null = null
  private config: TwitchConfig
  private connected = false
  private messageHandlers: MessageHandler[] = []
  private refreshTimer: ReturnType<typeof setTimeout> | null = null
  private currentToken: string

  constructor(config: TwitchConfig) {
    this.config = config
    this.currentToken = config.oauthToken
    this.createClient()
  }

  private createClient(): void {
    this.client = new tmi.Client({
      options: { debug: false },
      identity: {
        username: this.config.username,
        password: this.currentToken,
      },
      channels: [this.config.channel],
    })

    this.setupEventHandlers()
  }

  private setupEventHandlers(): void {
    if (!this.client) return

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
    if (!this.client) {
      throw new Error("Twitch client not initialized")
    }

    console.log(`[Twitch] Connecting to #${this.config.channel}...`)

    // Check if we have refresh token capability
    if (this.canAutoRefresh()) {
      console.log("[Twitch] Auto-refresh enabled - token will refresh automatically")
      await this.validateAndRefreshToken()
      this.scheduleTokenRefresh()
    } else {
      console.log("[Twitch] Auto-refresh not configured - token will expire in ~4 hours")
      console.log("[Twitch] Tip: Set TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET, and TWITCH_REFRESH_TOKEN for auto-refresh")
    }

    await this.client.connect()
  }

  async disconnect(): Promise<void> {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer)
      this.refreshTimer = null
    }

    if (this.connected && this.client) {
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
    if (!this.connected || !this.client) {
      console.warn("[Twitch] Not connected, cannot send message")
      return
    }

    await this.client.say(this.config.channel, message)
  }

  async sendClawMessage(clawName: string, message: string): Promise<void> {
    // Format claw messages with a distinctive prefix
    const formattedMessage = `[${clawName}]: ${message}`
    await this.sendMessage(formattedMessage)
  }

  // ========== Token Refresh Logic ==========

  private canAutoRefresh(): boolean {
    return !!(
      this.config.clientId &&
      this.config.clientSecret &&
      this.config.refreshToken
    )
  }

  private async validateAndRefreshToken(): Promise<void> {
    if (!this.canAutoRefresh()) return

    try {
      // Validate current token
      const isValid = await this.validateToken()

      if (!isValid) {
        console.log("[Twitch] Token invalid or expired, refreshing...")
        await this.refreshToken()
      } else {
        console.log("[Twitch] Token is valid")
      }
    } catch (err) {
      console.error("[Twitch] Token validation failed:", err)
      // Try to refresh anyway
      await this.refreshToken()
    }
  }

  private async validateToken(): Promise<boolean> {
    const token = this.currentToken.replace("oauth:", "")

    const response = await fetch("https://id.twitch.tv/oauth2/validate", {
      headers: {
        "Authorization": `OAuth ${token}`,
      },
    })

    if (response.ok) {
      const data = await response.json() as { expires_in: number }
      console.log(`[Twitch] Token expires in ${Math.round(data.expires_in / 60)} minutes`)
      return data.expires_in > 600 // Consider invalid if less than 10 minutes left
    }

    return false
  }

  private async refreshToken(): Promise<void> {
    if (!this.config.clientId || !this.config.clientSecret || !this.config.refreshToken) {
      throw new Error("Missing credentials for token refresh")
    }

    console.log("[Twitch] Refreshing access token...")

    const response = await fetch("https://id.twitch.tv/oauth2/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        grant_type: "refresh_token",
        refresh_token: this.config.refreshToken,
      }),
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`Token refresh failed: ${errorText}`)
    }

    const tokens = await response.json() as TokenRefreshResponse

    // Update the current token
    this.currentToken = `oauth:${tokens.access_token}`

    console.log(`[Twitch] Token refreshed! Expires in ${Math.round(tokens.expires_in / 3600)} hours`)

    // If we're connected, we need to reconnect with the new token
    if (this.connected) {
      console.log("[Twitch] Reconnecting with new token...")
      await this.reconnectWithNewToken()
    }
  }

  private async reconnectWithNewToken(): Promise<void> {
    // Disconnect current client
    if (this.client) {
      await this.client.disconnect().catch(() => {})
    }

    // Create new client with updated token
    this.createClient()

    // Reconnect
    if (this.client) {
      await this.client.connect()
    }
  }

  private scheduleTokenRefresh(): void {
    // Refresh token every 3 hours (tokens last ~4 hours)
    const refreshInterval = 3 * 60 * 60 * 1000 // 3 hours in ms

    this.refreshTimer = setTimeout(async () => {
      try {
        await this.refreshToken()
        // Schedule next refresh
        this.scheduleTokenRefresh()
      } catch (err) {
        console.error("[Twitch] Failed to refresh token:", err)
        // Retry in 5 minutes
        this.refreshTimer = setTimeout(() => {
          this.scheduleTokenRefresh()
        }, 5 * 60 * 1000)
      }
    }, refreshInterval)

    console.log("[Twitch] Next token refresh scheduled in 3 hours")
  }
}
