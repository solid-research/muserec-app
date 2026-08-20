# MuseRec - RAG-Based Music Recommendation System

MuseRec is a music recommendation application that utilizes a 5-step Retrieval-Augmented Generation (RAG) flow to provide verified, hallucination-free song recommendations. The system retrieves candidate songs from a local SQLite database, constrains the LLM to select only from verified candidates, and enriches the results with album art and audio previews.

## Architecture Overview

The recommendation pipeline follows a strict 5-step RAG flow:

1. **RETRIEVE** - Query the local SQLite database for 80 candidate songs based on user genres, liked artists, and vibe keywords.
2. **AUGMENT** - Build a constrained prompt containing the candidate pool, user profile, and listening history from Solid Pod.
3. **GENERATE** - Send the prompt to the selected LLM (OpenAI GPT, Google Gemini, or Anthropic Claude) to pick exactly 5 songs.
4. **VALIDATE** - Verify every LLM pick against the SQLite database to eliminate hallucinated songs.
5. **ENRICH** - Fetch album cover art and audio preview URLs from the Deezer API.

## Tech Stack

- **Frontend**: Next.js 14 (App Router), TypeScript, Tailwind CSS
- **Backend**: Next.js API Routes
- **Database**: SQLite with better-sqlite3 and FTS5 full-text search
- **LLM Providers**: OpenAI (via LiteLLM), Google Gemini, Anthropic Claude
- **Identity & Storage**: Solid Protocol (Inrupt SDK)
- **Music Metadata**: Deezer API

## Prerequisites

Before starting the installation, ensure your system meets the following requirements:

- Node.js v18.x or higher (v20.x LTS is recommended)
- npm v9.x or higher
- Python v3.11 or v3.12 (required for compiling native modules)
- Git

**Important Note on Python**: Python 3.14 is experimental and causes compilation errors with native modules. Use Python 3.12 for stable builds.

You can verify your installations by running the following commands in your terminal:

```bash
node --version
npm --version
python3 --version
git --version