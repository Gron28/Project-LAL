#!/usr/bin/env bash
# Run any command on the AMD GPU (ROCm) with the gfx1032 override + this project's venv.
#   sg render -c "bash gpu.sh python scripts/finetune.py ..."
cd ~/Desktop/local-ai-lab
source .venv/bin/activate
export HSA_OVERRIDE_GFX_VERSION=10.3.0
export HF_HUB_DISABLE_TELEMETRY=1
exec "$@"
