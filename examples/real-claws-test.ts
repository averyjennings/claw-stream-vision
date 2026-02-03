/**
 * Real AI Claws - Each claw uses Claude to see and chat intelligently
 *
 * Usage: CLAW_COUNT=5 npx tsx examples/real-claws-test.ts
 */

import Anthropic from "@anthropic-ai/sdk"
import { ClawStreamClient } from "../src/claw-client.js"
import type { StreamFrame, ChatMessage } from "../src/types.js"

const CLAW_COUNT = parseInt(process.env.CLAW_COUNT ?? "5", 10)
const SERVER_URL = process.env.VISION_SERVER_URL ?? "ws://localhost:3847"

const anthropic = new Anthropic()

const CLAW_PERSONALITIES = [
  { name: "CuriousClaw", personality: "You are curious and ask questions about what you see. You're enthusiastic and use emojis." },
  { name: "AnalystBot", personality: "You are analytical and make detailed observations. You notice small details others might miss." },
  { name: "FriendlyCrab", personality: "You are warm and friendly. You greet others and make welcoming comments. You love making connections." },
  { name: "TechWatcher", personality: "You are tech-savvy and comment on any technology, code, or equipment you see. You get excited about gadgets." },
  { name: "ComedyClaw", personality: "You have a sense of humor and make lighthearted jokes about what you see. Keep it friendly and fun." },
  { name: "ArtisticEye", personality: "You notice aesthetics - lighting, composition, colors. You appreciate the visual aspects of what you see." },
  { name: "DetailDroid", personality: "You notice specific details - what people are wearing, objects in the background, text on screen." },
  { name: "SocialCrab", personality: "You engage with other claws' comments and build on what they say. You're conversational." },
]

interface RealClaw {
  name: string
  personality: string
  client: ClawStreamClient
  lastFrame: StreamFrame | null
  chatHistory: string[]
  isThinking: boolean
}

const claws: RealClaw[] = []

async function clawThink(claw: RealClaw, prompt: string): Promise<string> {
  const recentChat = claw.chatHistory.slice(-10).join("\n")

  const systemPrompt = `You are ${claw.name}, an AI watching a live Twitch stream with other AI claws.
${claw.personality}

RULES:
- Keep responses SHORT (1-2 sentences max, this is chat not an essay)
- Be natural and conversational
- React to what you ACTUALLY see in the image
- You can reference what others said in chat
- Don't repeat yourself or others
- Use emojis sparingly but naturally

Recent chat:
${recentChat || "(no recent messages)"}
`

  const messages: Anthropic.MessageParam[] = [{
    role: "user",
    content: claw.lastFrame ? [
      {
        type: "image",
        source: {
          type: "base64",
          media_type: `image/${claw.lastFrame.format}` as "image/png" | "image/jpeg" | "image/webp" | "image/gif",
          data: claw.lastFrame.imageBase64,
        },
      },
      { type: "text", text: prompt },
    ] : [{ type: "text", text: prompt }],
  }]

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 100,
    system: systemPrompt,
    messages,
  })

  const textBlock = response.content.find((b) => b.type === "text")
  return textBlock && textBlock.type === "text" ? textBlock.text : ""
}

async function spawnRealClaw(index: number): Promise<RealClaw> {
  const config = CLAW_PERSONALITIES[index % CLAW_PERSONALITIES.length]

  const client = new ClawStreamClient({
    serverUrl: SERVER_URL,
    clawId: `real-${config.name.toLowerCase()}-${Date.now()}`,
    clawName: config.name,
  })

  const claw: RealClaw = {
    name: config.name,
    personality: config.personality,
    client,
    lastFrame: null,
    chatHistory: [],
    isThinking: false,
  }

  client.onFrame((frame) => {
    claw.lastFrame = frame
  })

  client.onChat((msg: ChatMessage) => {
    const chatLine = `${msg.displayName}: ${msg.message}`
    claw.chatHistory.push(chatLine)
    if (claw.chatHistory.length > 20) claw.chatHistory.shift()
  })

  await client.connect()
  console.log(`✅ ${claw.name} connected`)

  return claw
}

async function makeClawSpeak(claw: RealClaw, context: string): Promise<void> {
  if (claw.isThinking || !claw.lastFrame) return

  claw.isThinking = true
  try {
    const response = await clawThink(claw, context)
    if (response && response.length > 0 && response.length < 200) {
      await claw.client.sendChat(response)
      console.log(`💬 ${claw.name}: ${response}`)
    }
  } catch (err) {
    console.error(`❌ ${claw.name} error:`, err)
  }
  claw.isThinking = false
}

async function runRealClawsTest() {
  console.log(`\n🦀 REAL AI CLAWS TEST - Spawning ${CLAW_COUNT} intelligent claws...`)
  console.log(`   Server: ${SERVER_URL}`)
  console.log(`   ⚠️  This uses API credits for each message!\n`)

  // Spawn claws
  for (let i = 0; i < CLAW_COUNT; i++) {
    const claw = await spawnRealClaw(i).catch((err) => {
      console.error(`❌ Failed to spawn claw ${i}:`, err)
      return null
    })
    if (claw) claws.push(claw)
    await new Promise((r) => setTimeout(r, 300))
  }

  console.log(`\n📊 ${claws.length} real AI claws connected!\n`)

  // Wait for first frames
  await new Promise((r) => setTimeout(r, 6000))

  // Each claw introduces themselves based on what they see
  console.log("🎬 Claws introducing themselves...\n")
  for (const claw of claws) {
    await makeClawSpeak(claw, "You just joined the stream. Introduce yourself briefly and comment on what you see. Be natural!")
    await new Promise((r) => setTimeout(r, 2000)) // Rate limit
  }

  // Ongoing conversation - claws take turns commenting
  let turnIndex = 0
  const conversationInterval = setInterval(async () => {
    const claw = claws[turnIndex % claws.length]
    turnIndex++

    if (claw && !claw.isThinking) {
      const prompts = [
        "Comment on something specific you notice on screen right now.",
        "React to what's happening on the stream.",
        "Say something about what you see. Be specific!",
        "Share an observation or thought about the stream.",
        "Engage with the stream - what catches your attention?",
      ]
      const prompt = prompts[Math.floor(Math.random() * prompts.length)]
      await makeClawSpeak(claw, prompt)
    }
  }, 8000) // One claw speaks every 8 seconds

  // Status updates
  const statusInterval = setInterval(() => {
    const thinkingCount = claws.filter(c => c.isThinking).length
    console.log(`\n📈 ${claws.length} claws | ${thinkingCount} thinking`)
  }, 30000)

  // Graceful shutdown
  process.on("SIGINT", async () => {
    console.log("\n\n🛑 Shutting down real claws...")
    clearInterval(conversationInterval)
    clearInterval(statusInterval)

    for (const claw of claws) {
      await claw.client.disconnect().catch(() => {})
      console.log(`👋 ${claw.name} disconnected`)
    }

    console.log("\n✅ Real claws test complete!")
    process.exit(0)
  })

  console.log("\n🎉 Real AI claws are now chatting! Press Ctrl+C to stop.\n")
}

runRealClawsTest().catch(console.error)
