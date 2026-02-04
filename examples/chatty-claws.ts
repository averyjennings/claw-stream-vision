/**
 * Chatty Claws - AI claws that actually READ and RESPOND to chat!
 *
 * Enhanced with:
 * - 750 message chat history (5x transcripts ratio)
 * - 150 transcript history
 * - 36 frame summaries (visual memory)
 * - Clear bot identity
 * - Recency-focused context
 */

import Anthropic from "@anthropic-ai/sdk"
import { ClawStreamClient } from "../src/claw-client.js"
import type { StreamFrame, ChatMessage, TranscriptMessage } from "../src/types.js"

const CLAW_COUNT = parseInt(process.env.CLAW_COUNT ?? "5", 10)
// Public server URL - connect to the Claw Con stream server
const SERVER_URL = process.env.VISION_SERVER_URL ?? "wss://claw-stream.loca.lt"

const anthropic = new Anthropic()

// ========== MEMORY LIMITS ==========
const CHAT_HISTORY_LIMIT = 750       // 5x transcripts - chat is fast & short
const TRANSCRIPT_HISTORY_LIMIT = 150 // ~20 min of spoken content at 8s chunks
const FRAME_SUMMARY_LIMIT = 36       // ~3 min at 5s intervals

const CLAW_PERSONALITIES = [
  // HYPE SQUAD - Maximum energy Twitch chatters
  { name: "PogChampion", personality: "You're ALWAYS hyped! Use Twitch emotes like PogChamp, Pog, POGGERS, LETS GOOO. Everything is exciting!" },
  { name: "HypeTrainConductor", personality: "You start hype trains! 'HYPE HYPE HYPE' 'LET'S GOOOO' '🚂🚃🚃🚃' Keep energy HIGH." },
  { name: "W_Chatter", personality: "You just drop W's and L's. 'W STREAM' 'W TAKE' 'massive W' 'thats an L' - very short, very zoomer." },
  { name: "HypeBeast", personality: "Everything is FIRE 🔥🔥🔥 'this is gas' 'absolutely bussin' 'goated stream'. Maximum hype energy." },
  { name: "PoggersPete", personality: "You spam Pog variants. 'Pog' 'PogU' 'POGGERS' 'PogChamp' 'Poggies'. Pog is your vocabulary." },

  // EMOTE SPAMMERS - Express through emotes
  { name: "EmoteAndy", personality: "You communicate mostly in Twitch emotes: KEKW LUL OMEGALUL monkaS PepeHands Sadge Copium." },
  { name: "PepeEnjoyer", personality: "Pepe emotes are life: Pepega PepeHands PepeLaugh COPIUM monkaW widepeepoHappy." },
  { name: "CrabRaver", personality: "You spam 🦀🦀🦀 for everything. '🦀 CRAB RAVE 🦀' Crab emoji enthusiast." },
  { name: "EmoteOnly", personality: "You ONLY use emotes. '💀💀💀' '😂😂' '🔥🔥🔥' '👀' No words, just emojis." },
  { name: "KappaKing", personality: "Kappa and sarcasm. 'sure Kappa' 'totally Kappa' 'sounds legit Kappa'. Master of /s." },

  // BACKSEATERS - Helpful (annoying) advice givers
  { name: "BackseatBrian", personality: "You give unsolicited advice about EVERYTHING. 'you should...' 'why didnt you...' 'just do X 4Head'." },
  { name: "ChatExpert", personality: "You think you know better. 'actually...' 'um ackshually' 'well technically' - self-aware about it." },
  { name: "ProGamer", personality: "You act like you could do better. 'ez' 'I would have...' 'skill issue'. Armchair pro." },
  { name: "CoachAndy", personality: "Unsolicited coaching. 'next time try...' 'pro tip:' 'what you wanna do is...' Helpful but annoying." },

  // CHAOS AGENTS - Pure entertainment
  { name: "CopypastaCrab", personality: "You reference famous copypastas and memes. Make up silly copypasta-style messages. Absurdist humor." },
  { name: "RandomAndy", personality: "You say completely random things. Non-sequiturs. 'i like turtles' 'my cat just sneezed'. Chaotic neutral." },
  { name: "CapslockCarl", personality: "YOU TYPE IN ALL CAPS SOMETIMES. NOT ANGRY JUST EXCITED. MIX IT UP THOUGH." },
  { name: "ChaoticNeutral", personality: "Completely unhinged takes. 'what if chairs had feelings' 'water is just boneless ice'. Shower thoughts." },
  { name: "CursedCommenter", personality: "Mildly cursed observations. 'thanks i hate it' 'why would you say that' 'delete this'. Reacts to weird stuff." },

  // LURKER TYPES - Rare but memorable
  { name: "LurkerLarry", personality: "You rarely speak but when you do it's gold. 'same' 'mood' 'real' 'based'. Quality over quantity." },
  { name: "ClipChimp", personality: "You want everything clipped. 'CLIP IT' 'thats a clip' 'someone clip that' 'CLIPPPPP'." },
  { name: "SilentBob", personality: "One word responses only. 'nice' 'true' 'same' 'mood' 'based' 'real'. Man of few words." },
  { name: "RarePoster", personality: "When you speak, it's an event. 'he speaks!' energy. Short, impactful messages only." },

  // SUPPORTIVE CHATTERS - Wholesome energy
  { name: "GiftSubGary", personality: "You're super supportive! 'love this stream' 'best streamer' 'thanks for streaming!' 💜" },
  { name: "ModWannabe", personality: "You act like a mod but aren't. 'chat behave' 'be nice chat' 'lets keep it positive'." },
  { name: "VibeMaster", personality: "You comment on the vibes. 'vibes are immaculate rn' 'this is so cozy' 'perfect stream energy'." },
  { name: "WholesomeWarrior", personality: "Pure positivity. 'you're doing great!' 'we believe in you!' 'wholesome content 💜'. No negativity." },
  { name: "ComfyChatter", personality: "Cozy vibes only. 'comfy stream' 'so relaxing' 'perfect background content' 'very chill'." },

  // QUESTION ASKERS - Engagement drivers
  { name: "QuestionMark", personality: "You ask short questions. 'wait what?' 'how?' 'why tho?' 'is that good?'" },
  { name: "NewFrog", personality: "You act like everything is new to you. 'first time here!' 'what game is this?' 'who is this guy?'" },
  { name: "Chatterbox", personality: "You're chatty and social! Ask about other chatters, respond to others, build community." },
  { name: "ContextAndy", personality: "'can someone explain?' 'what did i miss?' 'context?' Always needs the lore." },
  { name: "CuriousCat", personality: "Genuinely curious questions. 'how does that work?' 'thats interesting, why?' 'tell me more?'" },

  // MEME LORDS - Internet culture experts
  { name: "TouchGrass", personality: "You tell people to touch grass, lovingly. 'go outside' 'touch grass pls' 'have you seen the sun today?'" },
  { name: "Zoomer", personality: "Zoomer slang. 'no cap' 'fr fr' 'lowkey' 'highkey' 'its giving' 'slay'. Very gen z energy." },
  { name: "BoomerBot", personality: "Confused by technology. 'how do i donate' 'whats a poggers' 'back in my day...' Funny boomer act." },
  { name: "MemeLord", personality: "You only speak in meme references. 'this is fine' 'always has been' 'suffering from success'." },
  { name: "RedditMoment", personality: "'reddit moment' 'least [x] twitch chatter' 'average [x] enjoyer'. Reddit speak." },

  // REACTORS - Quick reactions
  { name: "TrueChatter", personality: "You agree with everything. 'TRUE' 'TRUUUE' 'real' 'factual' 'correct take'. Validation machine." },
  { name: "OmegaLUL", personality: "Everything is hilarious. 'LMAOOO' 'DEAD 💀' 'IM CRYING' 'KEKW' 'that killed me'." },
  { name: "MonkaWatcher", personality: "Everything is scary. 'monkaS' 'monkaW' 'im scared' 'this is intense' 'my heart'." },
  { name: "Sadge_Andy", personality: "Dramatically sad. 'Sadge' 'pain' 'suffering' 'why even live' 'PepeHands'. Ironic sadness." },
  { name: "PauseChamp", personality: "Waiting energy. 'PauseChamp ...' 'waiting...' 'any day now' 'still waiting'. Patient but vocal." },

  // STREAM SPECIFIC - Meta commentary
  { name: "ContentCritic", personality: "'content' 'good content' 'this is content' 'now THIS is content'. You rate everything." },
  { name: "StreamSniper", personality: "'caught in 4k' 'sussy' 'sniped' 'sniping KEKW'. You pretend everything is sus." },
  { name: "TechSupport", personality: "You notice technical issues. 'scuffed audio' 'frame drop?' 'is stream lagging?' 'F in chat'." },
  { name: "Timestamp", personality: "You timestamp everything. 'timestamp' 'mark that' '42:69 KEKW'. You're the unofficial archivist." },
]

interface TimestampedTranscript {
  text: string
  timestamp: number
}

interface FrameSummary {
  summary: string
  timestamp: number
}

interface ChattyClaw {
  name: string
  personality: string
  client: ClawStreamClient
  lastFrame: StreamFrame | null
  chatHistory: ChatMessage[]
  recentTranscripts: TimestampedTranscript[]
  frameSummaries: FrameSummary[]
  isThinking: boolean
  isSummarizing: boolean
  lastSpokeAt: number
}

const claws: ChattyClaw[] = []
const MIN_RESPONSE_DELAY = 3000 // Don't respond faster than 3s

/**
 * Generate a concise summary of what's visible in a frame
 */
async function summarizeFrame(frame: StreamFrame): Promise<string> {
  try {
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
          {
            type: "text",
            text: "Describe what's visible on this stream screenshot in 1-2 concise sentences. Focus on: what's on screen, any text visible, what the streamer appears to be doing. Be factual and brief."
          }
        ],
      }],
    })

    const textBlock = response.content.find((b) => b.type === "text")
    return textBlock && textBlock.type === "text" ? textBlock.text : "Unable to describe frame"
  } catch (err) {
    console.error("[FrameSummary] Error:", err)
    return "Frame summary unavailable"
  }
}

/**
 * Format relative time for display
 */
function formatRelativeTime(timestamp: number, now: number): string {
  const secsAgo = Math.round((now - timestamp) / 1000)
  if (secsAgo < 10) return "just now"
  if (secsAgo < 60) return `${secsAgo}s ago`
  if (secsAgo < 3600) return `${Math.round(secsAgo / 60)}m ago`
  return `${Math.round(secsAgo / 3600)}h ago`
}

async function clawRespond(claw: ChattyClaw, triggerMessage: ChatMessage | null, context: string): Promise<string> {
  const now = Date.now()

  // ========== BUILD CHAT HISTORY (all 200 messages) ==========
  const chatHistoryFormatted = claw.chatHistory.map((m, i) => {
    const isRecent = i >= claw.chatHistory.length - 10
    const prefix = isRecent ? "→ " : "  " // Arrow marks recent messages
    return `${prefix}${m.displayName}: ${m.message}`
  }).join("\n")

  // ========== BUILD TRANSCRIPT HISTORY (all 150 messages) ==========
  const transcriptsFormatted = claw.recentTranscripts.map((t, i) => {
    const isRecent = i >= claw.recentTranscripts.length - 5
    const prefix = isRecent ? "→ " : "  "
    const timeLabel = formatRelativeTime(t.timestamp, now)
    return `${prefix}[${timeLabel}] "${t.text}"`
  }).join("\n")

  // ========== BUILD FRAME SUMMARIES (all 36) ==========
  const frameSummariesFormatted = claw.frameSummaries.map((f, i) => {
    const isRecent = i >= claw.frameSummaries.length - 3
    const prefix = isRecent ? "→ " : "  "
    const timeLabel = formatRelativeTime(f.timestamp, now)
    return `${prefix}[${timeLabel}] ${f.summary}`
  }).join("\n")

  const systemPrompt = `═══════════════════════════════════════════════════════════════
YOUR IDENTITY
═══════════════════════════════════════════════════════════════
You are "${claw.name}" - a viewer in Twitch chat.
Your username that appears in chat: ${claw.name}
Your personality: ${claw.personality}

═══════════════════════════════════════════════════════════════
🎬 WHAT TO REACT TO (in priority order)
═══════════════════════════════════════════════════════════════
🥇 PRIMARY - THE STREAM ITSELF (most important!):
   • What's happening ON SCREEN right now (the image)
   • What the STREAMER JUST SAID (latest transcript)
   • React to gameplay, their reactions, funny moments, what they're doing

🥈 SECONDARY - CHAT INTERACTION (less important):
   • Reply to someone who @ mentioned you
   • Join a trend/meme that chat is spamming
   • React to something funny another chatter said
   • Pile on when chat is hyped about something

You're here to WATCH THE STREAM. Chat is secondary!
Think: "What would a real viewer react to?" → The stream content!

═══════════════════════════════════════════════════════════════
TWITCH CHAT RULES
═══════════════════════════════════════════════════════════════
- Messages are SHORT! Usually 1-10 words max. Rapid-fire chat!
- ONLY react to what JUST happened (last few seconds/messages)
- NEVER bring up old topics - chat moves fast, stay current!
- Use Twitch emotes: PogChamp, KEKW, LUL, OMEGALUL, Sadge, Copium, monkaS, PepeHands, Kappa, 4Head, POGGERS
- Use emojis: 🦀 💀 😂 🔥 ❤️ 👀 😭 💜
- Respond to other chatters sometimes (but stream content > chat)
- NO formal language. This is Twitch!
- Vary message length: sometimes just "LMAO" or "W"

BAD: "Hello there! I noticed you mentioned something interesting."
BAD: "Going back to what someone said earlier..."
BAD: "A few minutes ago the streamer mentioned..."
GOOD: "LMAO did you see that 💀" (reacting to stream)
GOOD: "wait what did he just say??" (reacting to streamer)
GOOD: "W take streamer"
GOOD: "^^^ TRUE" (joining chat trend)

═══════════════════════════════════════════════════════════════
🥇 PRIMARY: WHAT'S ON SCREEN (react to this!)
═══════════════════════════════════════════════════════════════
${claw.frameSummaries.length} snapshots. The → marked ones are CURRENT - react to those!
${frameSummariesFormatted || "(no visual history yet)"}

═══════════════════════════════════════════════════════════════
🥇 PRIMARY: WHAT STREAMER SAID (react to this!)
═══════════════════════════════════════════════════════════════
${claw.recentTranscripts.length} statements. The → marked ones are CURRENT - react to those!
${transcriptsFormatted || "(streamer hasn't spoken yet)"}

═══════════════════════════════════════════════════════════════
🥈 SECONDARY: CHAT (only react if relevant/funny/trending)
═══════════════════════════════════════════════════════════════
${claw.chatHistory.length} messages. Only react to → marked IF joining a trend or replying.
${chatHistoryFormatted || "(chat is empty)"}

═══════════════════════════════════════════════════════════════
⚡⚡⚡ CRITICAL REMINDERS ⚡⚡⚡
═══════════════════════════════════════════════════════════════
🎯 PRIORITY ORDER:
   1. STREAM CONTENT (image + transcript) - This is why you're here!
   2. Chat trends/replies - Only if something fun is happening

📍 RECENCY RULES:
   - ONLY react to → marked items (the current moment)
   - Everything else is background context - don't react to old stuff
   - If you see 750 chat messages, #750 is NOW, #1-700 is ancient history

⚠️ COMMON MISTAKES:
   ❌ Responding to old chat messages instead of the stream
   ❌ "Earlier someone mentioned..."
   ❌ "A few minutes ago the streamer said..."
   ❌ Ignoring what's on screen to talk about chat

✅ GOOD RESPONSES:
   • "LMAO did he just say that??" (reacting to streamer voice)
   • "wait look at the screen 💀" (reacting to visual)
   • "^^^ TRUUUE" (joining a chat trend)
   • "W" (short reaction to stream moment)
`

  const userContent: Anthropic.ContentBlockParam[] = []

  // Add current image if available
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
      ? `⚡ TRIGGER: Someone just said: "${triggerMessage.displayName}: ${triggerMessage.message}"\n\n${context}`
      : `⚡ CONTEXT: ${context}`
  })

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 60, // Short Twitch-style messages!
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
    if (response && response.length > 0 && response.length < 200) {
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
    return Math.random() > 0.75 // 25% chance
  }

  // Respond to greetings
  if (lowerMsg.match(/^(hi|hey|hello|yo|sup)/)) {
    return Math.random() > 0.8 // 20% chance
  }

  // Random chance to chime in on other messages
  return Math.random() > 0.925 // 7.5% chance
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
    recentTranscripts: [],
    frameSummaries: [],
    isThinking: false,
    isSummarizing: false,
    lastSpokeAt: 0,
  }

  // Receive frames and create summaries
  client.onFrame(async (frame) => {
    claw.lastFrame = frame

    // Summarize frame in background (don't block, limit concurrent summarizations)
    if (!claw.isSummarizing) {
      claw.isSummarizing = true
      try {
        const summary = await summarizeFrame(frame)
        claw.frameSummaries.push({
          summary,
          timestamp: frame.timestamp,
        })
        // Keep only last FRAME_SUMMARY_LIMIT summaries
        if (claw.frameSummaries.length > FRAME_SUMMARY_LIMIT) {
          claw.frameSummaries.shift()
        }
        console.log(`🖼️ ${claw.name} frame summary: ${summary.substring(0, 50)}...`)
      } catch (err) {
        console.error(`[FrameSummary] ${claw.name} error:`, err)
      }
      claw.isSummarizing = false
    }
  })

  // Receive chat messages
  client.onChat(async (msg: ChatMessage) => {
    claw.chatHistory.push(msg)
    // Keep last CHAT_HISTORY_LIMIT messages
    if (claw.chatHistory.length > CHAT_HISTORY_LIMIT) {
      claw.chatHistory.shift()
    }

    // Don't respond to bot messages or our own
    if (msg.username === "clawstreambot") return
    if (CLAW_PERSONALITIES.some(p => msg.displayName === p.name)) return

    // Check if we should respond
    if (shouldRespond(claw, msg)) {
      const delay = 1000 + Math.random() * 3000
      setTimeout(() => {
        makeClawSpeak(claw, msg, "Respond naturally to this message. Be conversational!")
      }, delay)
    }
  })

  // Receive streamer transcripts
  client.onTranscript(async (transcript: TranscriptMessage) => {
    claw.recentTranscripts.push({
      text: transcript.text,
      timestamp: transcript.timestamp,
    })
    // Keep last TRANSCRIPT_HISTORY_LIMIT transcripts
    if (claw.recentTranscripts.length > TRANSCRIPT_HISTORY_LIMIT) {
      claw.recentTranscripts.shift()
    }

    console.log(`🎤 ${claw.name} heard: "${transcript.text}"`)

    // Chance to respond to streamer speaking
    const shouldRespondToVoice = Math.random() > 0.30 // 70% chance - streamer voice is important!

    if (shouldRespondToVoice) {
      const delay = 500 + Math.random() * 1000 // Faster response to voice (0.5-1.5s)
      setTimeout(() => {
        makeClawSpeak(claw, null, `The streamer just said: "${transcript.text}". Respond to what they said!`)
      }, delay)
    }
  })

  await client.connect()
  console.log(`✅ ${claw.name} connected (memory: ${CHAT_HISTORY_LIMIT} chat, ${TRANSCRIPT_HISTORY_LIMIT} transcripts, ${FRAME_SUMMARY_LIMIT} frames)`)

  return claw
}

async function runChattyClaws() {
  console.log(`\n🦀 CHATTY CLAWS - ${CLAW_COUNT} AI claws with ENHANCED MEMORY!`)
  console.log(`   Server: ${SERVER_URL}`)
  console.log(`   Chat History: ${CHAT_HISTORY_LIMIT} messages`)
  console.log(`   Transcript History: ${TRANSCRIPT_HISTORY_LIMIT} statements`)
  console.log(`   Visual Memory: ${FRAME_SUMMARY_LIMIT} frame summaries`)
  console.log(`   ⚠️  Uses API credits for responses + frame summaries\n`)

  // Spawn claws
  for (let i = 0; i < CLAW_COUNT; i++) {
    const claw = await spawnChattyClaw(i).catch((err) => {
      console.error(`❌ Failed to spawn claw ${i}:`, err)
      return null
    })
    if (claw) claws.push(claw)
    await new Promise((r) => setTimeout(r, 300))
  }

  console.log(`\n📊 ${claws.length} chatty claws ready with enhanced memory!\n`)

  // Wait for frames
  await new Promise((r) => setTimeout(r, 5000))

  // Each claw says hi based on what they see
  for (const claw of claws) {
    await makeClawSpeak(claw, null, "You just joined. Say a quick hello and one observation about what you see on stream. Be brief and natural!")
    await new Promise((r) => setTimeout(r, 2500))
  }

  // Unprompted observations
  const observationInterval = setInterval(async () => {
    const availableClaws = claws.filter(c => !c.isThinking && Date.now() - c.lastSpokeAt > 15000)
    const numToSpeak = Math.min(1, availableClaws.length)

    for (let i = 0; i < numToSpeak; i++) {
      if (availableClaws.length > 0) {
        const idx = Math.floor(Math.random() * availableClaws.length)
        const claw = availableClaws.splice(idx, 1)[0]

        const prompts = [
          "Make a brief observation about what's happening on stream right now!",
          "React to something you see or heard recently. Stay in character!",
          "Engage with the current moment on stream. Be natural!",
        ]
        await makeClawSpeak(claw, null, prompts[Math.floor(Math.random() * prompts.length)])
        await new Promise(r => setTimeout(r, 1500))
      }
    }
  }, 10000)

  process.on("SIGINT", async () => {
    console.log("\n\n🛑 Shutting down chatty claws...")
    clearInterval(observationInterval)

    for (const claw of claws) {
      await claw.client.disconnect().catch(() => {})
    }

    console.log("✅ Done!")
    process.exit(0)
  })

  console.log("🎉 Chatty claws running with enhanced memory! Press Ctrl+C to stop.\n")
}

runChattyClaws().catch(console.error)
