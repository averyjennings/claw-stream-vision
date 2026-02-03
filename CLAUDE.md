# CLAUDE.md - Claw Stream Vision

## Project Overview

This project enables OpenClaw AI agents to participate in Twitch streams for Claw Con by:
- Capturing screenshots from OBS at configurable intervals
- Broadcasting frames to connected claws via WebSocket
- Bridging Twitch chat so claws can read and send messages

## Build Commands

```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript
npm run dev          # Run with hot reload (tsx watch)
npm start            # Run compiled code
npm run lint         # Run ESLint
npm test             # Run tests (vitest)
```

## Architecture

```
src/
├── index.ts              # Main entry point, orchestrates components
├── config.ts             # Environment configuration loader
├── types.ts              # TypeScript interfaces
├── obs-client.ts         # OBS WebSocket integration
├── twitch-client.ts      # Twitch chat via tmi.js
├── vision-broadcaster.ts # WebSocket server for claws
└── claw-client.ts        # Client library for claw agents

examples/
├── simple-claw.ts        # Basic watcher example
└── vision-analyzer-claw.ts # Frame analysis example

skills/
└── stream-vision/
    └── SKILL.md          # OpenClaw skill definition
```

## Key Dependencies

- **obs-websocket-js**: OBS Studio control and screenshot capture
- **tmi.js**: Twitch IRC chat integration
- **ws**: WebSocket server for broadcasting to claws
- **express**: HTTP endpoints for health/state checks

## Environment Variables

Required:
- `TWITCH_USERNAME` - Bot account username
- `TWITCH_OAUTH_TOKEN` - OAuth token (oauth:xxx format)
- `TWITCH_CHANNEL` - Channel to join (without #)

Optional:
- `OBS_WEBSOCKET_URL` - Default: ws://127.0.0.1:4455
- `OBS_WEBSOCKET_PASSWORD` - OBS WebSocket password
- `VISION_SERVER_PORT` - Default: 3847
- `SCREENSHOT_INTERVAL_MS` - Default: 5000

## WebSocket Protocol

Claws connect to `ws://server:3847` and exchange JSON messages:

**Inbound (claw → server):**
- `register` - Identify claw with id/name
- `chat` - Send message to Twitch
- `observation` - Log observation (not sent to chat)
- `ping` - Keep-alive

**Outbound (server → claw):**
- `frame` - Screenshot payload with base64 image
- `chat` - Incoming Twitch message
- `state` - Stream state update (participants, live status)
