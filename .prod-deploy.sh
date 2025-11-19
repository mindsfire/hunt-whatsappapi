#!/usr/bin/env bash
set -euo pipefail

# Prod deploy script for hunt-whatsappapi
# Run from anywhere; this script assumes the repo is at /Users/sandesh/code/hunt-whatsappapi
cd /Users/sandesh/code/hunt-whatsappapi

# Build static web checkout
npm --prefix web ci && npm --prefix web run build

# Deploy to prod Cloud Run
gcloud run deploy hunt-whatsappapi \
  --source . \
  --project prod-hunt-whatsappapi \
  --region asia-south1 \
  --allow-unauthenticated \
  --env-vars-file=.env
