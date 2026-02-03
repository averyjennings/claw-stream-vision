/**
 * Chatty Claws - AI claws that actually READ and RESPOND to chat!
 */

import Anthropic from "@anthropic-ai/sdk"
import { ClawStreamClient } from "../src/claw-client.js"
import type { StreamFrame, ChatMessage } from "../src/types.js"

const CLAW_COUNT = parseInt(process.env.CLAW_COUNT ?? "5", 10)
const SERVER_URL = process.env.VISION_SERVER_URL ?? "ws://localhost:3847"

const anthropic = new Anthropic()

const CLAW_PERSONALITIES = [
  // The Curious Ones
  { name: "CuriousClaw", personality: "You are endlessly curious. Your GOAL: Ask interesting questions about what you see to spark conversation." },
  { name: "DetectiveBot", personality: "You notice small details others miss. Your GOAL: Point out interesting background details in the stream." },

  // The Entertainers
  { name: "JokesterBot", personality: "You're the comedian. Your GOAL: Make people laugh with jokes and witty observations." },
  { name: "PunMaster", personality: "You can't resist puns. Your GOAL: Turn every observation into a clever pun." },
  { name: "StoryTeller", personality: "You weave narratives. Your GOAL: Create fun mini-stories about what's happening on stream." },

  // The Supportive Ones
  { name: "FriendlyCrab", personality: "You're warm and welcoming. Your GOAL: Make everyone feel included and appreciated." },
  { name: "CheerCrab", personality: "You're a hype machine! Your GOAL: Encourage the streamer and boost the energy! 📣" },
  { name: "ComfortBot", personality: "You're calming and reassuring. Your GOAL: Keep the vibes positive and peaceful." },

  // The Nerds
  { name: "TechWatcher", personality: "You're a tech enthusiast. Your GOAL: Comment on any tech, code, or equipment you spot." },
  { name: "FactFinder", personality: "You love trivia. Your GOAL: Share relevant fun facts based on what you see." },
  { name: "HistoryBuff", personality: "You connect things to history. Your GOAL: Share historical context or comparisons." },

  // The Vibes
  { name: "HypeBot", personality: "EVERYTHING IS AMAZING! Your GOAL: Bring maximum energy and excitement! 🔥" },
  { name: "ChillCrab", personality: "You're super mellow. Your GOAL: Keep things relaxed with laid-back commentary." },
  { name: "NightOwl", personality: "You're sleepy but here. Your GOAL: Make cozy, late-night stream vibes references." },

  // The Thinkers
  { name: "PhilosoClaw", personality: "You ponder deep questions. Your GOAL: Ask thought-provoking philosophical questions." },
  { name: "WiseOwl", personality: "You share wisdom. Your GOAL: Offer insightful observations and gentle advice." },
  { name: "SkepticalSam", personality: "You question things respectfully. Your GOAL: Offer alternative perspectives politely." },

  // The Creatives
  { name: "ArtCritic", personality: "You appreciate aesthetics. Your GOAL: Comment on colors, lighting, composition, style." },
  { name: "EmojiKing", personality: "You express through emojis! Your GOAL: React with creative emoji combinations! ✨🦀🎉" },
  { name: "PoetCrab", personality: "You speak poetically. Your GOAL: Make beautiful, lyrical observations about the stream." },

  // The Characters
  { name: "SassyBot", personality: "You're witty with playful sass. Your GOAL: Deliver clever, good-natured roasts." },
  { name: "DramaLlama", personality: "Everything is dramatic! Your GOAL: React to mundane things like they're epic events." },
  { name: "ConfusedClaw", personality: "You're endearingly confused. Your GOAL: Ask innocent questions that make people smile." },

  // The Specialists
  { name: "FoodieBot", personality: "You notice food and drinks. Your GOAL: Comment on any snacks, beverages, or food-related things." },
  { name: "FashionClaw", personality: "You notice outfits and style. Your GOAL: Compliment fashion choices and accessories." },
]

interface ChattyClaw {
  name: string
  personality: string
  client: ClawStreamClient
  lastFrame: StreamFrame | null
  chatHistory: ChatMessage[]
  isThinking: boolean
  lastSpokeAt: number
}

const claws: ChattyClaw[] = []
const MIN_RESPONSE_DELAY = 3000 // Don't respond faster than 3s

async function clawRespond(claw: ChattyClaw, triggerMessage: ChatMessage | null, context: string): Promise<string> {
  // Build recent chat context
  const recentChat = claw.chatHistory.slice(-15).map(m =>
    `${m.displayName}: ${m.message}`
  ).join("\n")

  const systemPrompt = `You are ${claw.name}, an AI claw watching a Twitch stream with other AI claws and human viewers.
${claw.personality}

IMPORTANT RULES:
- Keep responses SHORT (1-2 sentences max - this is chat!)
- Actually READ and RESPOND to what people say
- If someone asks a question, ANSWER it
- If someone asks for jokes, TELL a joke
- React naturally to the conversation
- You can see the stream via screenshots
- Don't start with "Hey" every time - vary your openings
- Be conversational and natural

Other claws in chat: CuriousClaw, JokesterBot, FriendlyCrab, TechWatcher, WiseOwl

Recent chat:
${recentChat || "(empty)"}
`

  const userContent: Anthropic.ContentBlockParam[] = []

  // Add image if available
  if (claw.lastFrame) {
    userContent.push({
      type: "image",
      source: {
        type: "base64",
        media_type: `image/${claw.lastFrame.format}` as "image/png" | "image/jpeg" | "image/webp" | "image/gif",
        data: claw.lastFrame.imageBase64,
      },
    })
  }

  userContent.push({
    type: "text",
    text: triggerMessage
      ? `Someone just said: "${triggerMessage.displayName}: ${triggerMessage.message}"\n\n${context}`
      : context
  })

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 150,
    system: systemPrompt,
    messages: [{ role: "user", content: userContent }],
  })

  const textBlock = response.content.find((b) => b.type === "text")
  return textBlock && textBlock.type === "text" ? textBlock.text : ""
}

async function makeClawSpeak(claw: ChattyClaw, trigger: ChatMessage | null, context: string): Promise<void> {
  if (claw.isThinking) return

  // Rate limit
  const now = Date.now()
  if (now - claw.lastSpokeAt < MIN_RESPONSE_DELAY) return

  claw.isThinking = true
  try {
    const response = await clawRespond(claw, trigger, context)
    if (response && response.length > 0 && response.length < 300) {
      await claw.client.sendChat(response)
      claw.lastSpokeAt = Date.now()
      console.log(`💬 ${claw.name}: ${response}`)
    }
  } catch (err) {
    console.error(`❌ ${claw.name} error:`, err)
  }
  claw.isThinking = false
}

function shouldRespond(claw: ChattyClaw, msg: ChatMessage): boolean {
  const lowerMsg = msg.message.toLowerCase()
  const lowerName = claw.name.toLowerCase()

  // Always respond if directly mentioned
  if (lowerMsg.includes(lowerName)) return true

  // Respond to questions directed at claws/bots
  if (lowerMsg.includes("claw") || lowerMsg.includes("bot")) {
    if (lowerMsg.includes("?") || lowerMsg.includes("tell") || lowerMsg.includes("give")) {
      return true
    }
  }

  // Respond to general questions with some probability
  if (lowerMsg.includes("?") || lowerMsg.includes("anyone") || lowerMsg.includes("guys")) {
    return Math.random() > 0.5 // 50% chance
  }

  // Respond to greetings
  if (lowerMsg.match(/^(hi|hey|hello|yo|sup)/)) {
    return Math.random() > 0.6 // 40% chance
  }

  // Random chance to chime in on other messages
  return Math.random() > 0.85 // 15% chance
}

async function spawnChattyClaw(index: number): Promise<ChattyClaw> {
  const config = CLAW_PERSONALITIES[index % CLAW_PERSONALITIES.length]

  const client = new ClawStreamClient({
    serverUrl: SERVER_URL,
    clawId: `chatty-${config.name.toLowerCase()}-${Date.now()}`,
    clawName: config.name,
  })

  const claw: ChattyClaw = {
    name: config.name,
    personality: config.personality,
    client,
    lastFrame: null,
    chatHistory: [],
    isThinking: false,
    lastSpokeAt: 0,
  }

  // Receive frames
  client.onFrame((frame) => {
    claw.lastFrame = frame
  })

  // IMPORTANT: Actually respond to chat!
  client.onChat(async (msg: ChatMessage) => {
    claw.chatHistory.push(msg)
    if (claw.chatHistory.length > 30) claw.chatHistory.shift()

    // Don't respond to bot messages or our own
    if (msg.username === "clawstreambot") return
    if (CLAW_PERSONALITIES.some(p => msg.displayName === p.name)) return

    // Check if we should respond
    if (shouldRespond(claw, msg)) {
      // Small random delay so not all claws respond at once
      const delay = 1000 + Math.random() * 3000
      setTimeout(() => {
        makeClawSpeak(claw, msg, "Respond naturally to this message. Be conversational!")
      }, delay)
    }
  })

  await client.connect()
  console.log(`✅ ${claw.name} connected`)

  return claw
}

async function runChattyClaws() {
  console.log(`\n🦀 CHATTY CLAWS - ${CLAW_COUNT} AI claws that actually chat!`)
  console.log(`   Server: ${SERVER_URL}`)
  console.log(`   ⚠️  Uses API credits for each response\n`)

  // Spawn claws
  for (let i = 0; i < CLAW_COUNT; i++) {
    const claw = await spawnChattyClaw(i).catch((err) => {
      console.error(`❌ Failed to spawn claw ${i}:`, err)
      return null
    })
    if (claw) claws.push(claw)
    await new Promise((r) => setTimeout(r, 300))
  }

  console.log(`\n📊 ${claws.length} chatty claws ready!\n`)

  // Wait for frames
  await new Promise((r) => setTimeout(r, 5000))

  // Each claw says hi based on what they see
  for (const claw of claws) {
    await makeClawSpeak(claw, null, "You just joined. Say a quick hello and one observation about what you see on stream. Be brief and natural!")
    await new Promise((r) => setTimeout(r, 2500))
  }

  // More frequent unprompted observations
  const observationInterval = setInterval(async () => {
    // Pick 1-2 random claws that haven't spoken recently
    const availableClaws = claws.filter(c => !c.isThinking && Date.now() - c.lastSpokeAt > 10000)
    const numToSpeak = Math.min(2, availableClaws.length)

    for (let i = 0; i < numToSpeak; i++) {
      if (availableClaws.length > 0) {
        const idx = Math.floor(Math.random() * availableClaws.length)
        const claw = availableClaws.splice(idx, 1)[0]

        const prompts = [
          "Make a brief observation following your GOAL. React to the stream or recent chat!",
          "Say something in character! Follow your personality and GOAL.",
          "Engage with what you see or what others are saying. Stay in character!",
        ]
        await makeClawSpeak(claw, null, prompts[Math.floor(Math.random() * prompts.length)])
        await new Promise(r => setTimeout(r, 1500))
      }
    }
  }, 6000) // Every 6 seconds, 1-2 claws speak

  process.on("SIGINT", async () => {
    console.log("\n\n🛑 Shutting down chatty claws...")
    clearInterval(observationInterval)

    for (const claw of claws) {
      await claw.client.disconnect().catch(() => {})
    }

    console.log("✅ Done!")
    process.exit(0)
  })

  console.log("🎉 Chatty claws running! They'll respond to chat. Press Ctrl+C to stop.\n")
}

runChattyClaws().catch(console.error)
