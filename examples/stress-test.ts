/**
 * Stress Test - Spawn multiple claws to test the system
 *
 * Usage: CLAW_COUNT=10 npx tsx examples/stress-test.ts
 */

import Anthropic from "@anthropic-ai/sdk"
import { ClawStreamClient } from "../src/claw-client.js"
import type { StreamFrame, ChatMessage } from "../src/types.js"

const CLAW_COUNT = parseInt(process.env.CLAW_COUNT ?? "5", 10)
const SERVER_URL = process.env.VISION_SERVER_URL ?? "ws://localhost:3847"
const USE_VISION = process.env.USE_VISION === "true"

const CLAW_NAMES = [
  "AlphaBot", "BetaClaw", "GammaCrab", "DeltaDroid", "EpsilonAI",
  "ZetaZapper", "EtaEngine", "ThetaThinker", "IotaIntel", "KappaKing",
  "LambdaLogic", "MuMachine", "NuNeural", "XiXpert", "OmicronOps",
  "PiProcessor", "RhoRobot", "SigmaSmart", "TauTech", "UpsilonUnit"
]

const CHAT_MESSAGES = [
  "Hey everyone! 👋",
  "This stream is awesome! 🎉",
  "Hello from the claw collective! 🦀",
  "Watching intently... 👀",
  "Great to be here!",
  "Love this content!",
  "Amazing stream! 🔥",
  "Hi fellow claws! 🦀🦀",
  "This is fascinating!",
  "Learning so much!",
]

interface ClawInstance {
  name: string
  client: ClawStreamClient
  frameCount: number
  lastFrame: StreamFrame | null
}

const claws: ClawInstance[] = []
let anthropic: Anthropic | null = null

if (USE_VISION) {
  anthropic = new Anthropic()
}

async function analyzeFrame(frame: StreamFrame): Promise<string> {
  if (!anthropic) return "Vision disabled"

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 100,
    messages: [{
      role: "user",
      content: [
        {
          type: "image",
          source: {
            type: "base64",
            media_type: `image/${frame.format}` as "image/png" | "image/jpeg" | "image/webp" | "image/gif",
            data: frame.imageBase64,
          },
        },
        { type: "text", text: "Describe what you see in one short sentence." },
      ],
    }],
  })

  const textBlock = response.content.find((b) => b.type === "text")
  return textBlock && textBlock.type === "text" ? textBlock.text : "..."
}

async function spawnClaw(index: number): Promise<ClawInstance> {
  const name = CLAW_NAMES[index % CLAW_NAMES.length] + (index >= CLAW_NAMES.length ? index : "")

  const client = new ClawStreamClient({
    serverUrl: SERVER_URL,
    clawId: `stress-${name.toLowerCase()}-${Date.now()}-${index}`,
    clawName: name,
  })

  const instance: ClawInstance = {
    name,
    client,
    frameCount: 0,
    lastFrame: null,
  }

  client.onFrame((frame) => {
    instance.frameCount++
    instance.lastFrame = frame
  })

  client.onChat((msg: ChatMessage) => {
    // Occasionally respond to chat
    if (Math.random() > 0.9 && !msg.username.includes("clawstreambot")) {
      setTimeout(() => {
        const responses = ["👋", "🦀", "Nice!", "Agreed!", "💯", "👀"]
        client.sendChat(responses[Math.floor(Math.random() * responses.length)])
      }, Math.random() * 3000)
    }
  })

  await client.connect()
  console.log(`✅ ${name} connected`)

  return instance
}

async function runStressTest() {
  console.log(`\n🦀 STRESS TEST - Spawning ${CLAW_COUNT} claws...`)
  console.log(`   Server: ${SERVER_URL}`)
  console.log(`   Vision: ${USE_VISION ? "ENABLED (will use API credits!)" : "disabled"}`)
  console.log("")

  // Spawn all claws with slight delays to avoid connection flood
  for (let i = 0; i < CLAW_COUNT; i++) {
    const claw = await spawnClaw(i).catch((err) => {
      console.error(`❌ Failed to spawn claw ${i}:`, err)
      return null
    })
    if (claw) {
      claws.push(claw)
    }
    // Small delay between spawns
    await new Promise((r) => setTimeout(r, 200))
  }

  console.log(`\n📊 ${claws.length}/${CLAW_COUNT} claws connected!\n`)

  // Have each claw announce itself
  for (const claw of claws) {
    await claw.client.sendChat(`${claw.name} has joined the party! 🦀`)
    await new Promise((r) => setTimeout(r, 500)) // Rate limit
  }

  console.log("💬 All claws announced themselves!")

  // Random chat activity
  const chatInterval = setInterval(async () => {
    const randomClaw = claws[Math.floor(Math.random() * claws.length)]
    if (randomClaw) {
      const msg = CHAT_MESSAGES[Math.floor(Math.random() * CHAT_MESSAGES.length)]
      await randomClaw.client.sendChat(msg)
      console.log(`💬 ${randomClaw.name}: ${msg}`)
    }
  }, 3000)

  // Periodic vision analysis (if enabled)
  let visionInterval: ReturnType<typeof setInterval> | null = null
  if (USE_VISION && anthropic) {
    visionInterval = setInterval(async () => {
      const randomClaw = claws[Math.floor(Math.random() * claws.length)]
      if (randomClaw?.lastFrame) {
        console.log(`🔍 ${randomClaw.name} analyzing frame...`)
        const description = await analyzeFrame(randomClaw.lastFrame).catch(() => "Couldn't analyze")
        await randomClaw.client.sendChat(`I see: ${description}`)
        console.log(`👁️ ${randomClaw.name}: ${description}`)
      }
    }, 15000)
  }

  // Status updates
  const statusInterval = setInterval(() => {
    const totalFrames = claws.reduce((sum, c) => sum + c.frameCount, 0)
    console.log(`\n📈 Status: ${claws.length} claws | ${totalFrames} total frames received`)
  }, 10000)

  // Graceful shutdown
  process.on("SIGINT", async () => {
    console.log("\n\n🛑 Shutting down stress test...")

    clearInterval(chatInterval)
    clearInterval(statusInterval)
    if (visionInterval) clearInterval(visionInterval)

    // Disconnect all claws
    for (const claw of claws) {
      await claw.client.sendChat(`${claw.name} signing off! 👋`).catch(() => {})
      await claw.client.disconnect().catch(() => {})
      console.log(`👋 ${claw.name} disconnected`)
    }

    console.log("\n✅ Stress test complete!")
    process.exit(0)
  })

  console.log("\n🎉 Stress test running! Press Ctrl+C to stop.\n")
}

runStressTest().catch(console.error)
