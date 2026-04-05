#!/bin/bash
set -e

export PATH="$HOME/.local/share/solana/install/active_release/bin:$HOME/.cargo/bin:$HOME/.nvm/versions/node/$(ls $HOME/.nvm/versions/node 2>/dev/null | tail -1)/bin:$PATH"
cd /mnt/c/Users/NeCDeT/Desktop/tobestable-protocol
unset NODE_OPTIONS

# Kill any old validator
pkill -f solana-test-validator 2>/dev/null || true
sleep 2

# Start validator in background
echo "Starting validator..."
solana-test-validator --reset \
  --bpf-program metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s \
  /mnt/c/Users/NeCDeT/AppData/Local/Temp/metaplex.so \
  > /dev/null 2>&1 &

# Wait for validator
echo "Waiting for validator..."
for i in $(seq 1 30); do
  if solana cluster-version --url http://127.0.0.1:8899 2>/dev/null; then
    echo "Validator ready!"
    break
  fi
  sleep 1
done

# Deploy
echo "Deploying program..."
solana program deploy \
  --url http://127.0.0.1:8899 \
  --keypair ~/.config/solana/id.json \
  --program-id /mnt/c/Users/NeCDeT/Desktop/tobestable-protocol/target/deploy/neco_token-keypair.json \
  /mnt/c/Users/NeCDeT/Desktop/tobestable-protocol/target/deploy/neco_token.so

echo "Running tests..."
ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 \
ANCHOR_WALLET=~/.config/solana/id.json \
./node_modules/.bin/ts-mocha -p ./tsconfig.json -t 1000000 tests/neco_token.ts
