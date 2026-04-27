#!/usr/bin/env node

/**
 * Setup script for Ground Truth Stripe integration
 *
 * This script:
 * 1. Creates a Stripe product for Ground Truth
 * 2. Creates a $9/month recurring price
 * 3. Creates a webhook endpoint
 * 4. Outputs the price ID and webhook secret for wrangler secrets
 */

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY; // Set via: export STRIPE_SECRET_KEY=sk_live_...
const WEBHOOK_URL = "https://ground-truth-mcp.anishdasmail.workers.dev/api/webhook";

async function createProduct() {
  console.log("📦 Creating Stripe product...");
  
  const response = await fetch("https://api.stripe.com/v1/products", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      name: "Ground Truth",
      description: "Verification layer for AI agents with endpoint checks, claim verification, market checks, and competitor comparisons",
    }),
  });

  const product = await response.json();
  
  if (product.error) {
    throw new Error(`Failed to create product: ${product.error.message}`);
  }

  console.log(`✅ Product created: ${product.id}`);
  return product.id;
}

async function createPrice(productId) {
  console.log("💰 Creating $9/month recurring price...");
  
  const response = await fetch("https://api.stripe.com/v1/prices", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      product: productId,
      unit_amount: "900", // $9.00 in cents
      currency: "usd",
      "recurring[interval]": "month",
    }),
  });

  const price = await response.json();
  
  if (price.error) {
    throw new Error(`Failed to create price: ${price.error.message}`);
  }

  console.log(`✅ Price created: ${price.id}`);
  return price.id;
}

async function createWebhook() {
  console.log("🔗 Creating webhook endpoint...");
  
  const response = await fetch("https://api.stripe.com/v1/webhook_endpoints", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      url: WEBHOOK_URL,
      "enabled_events[0]": "checkout.session.completed",
      "enabled_events[1]": "customer.subscription.updated",
      "enabled_events[2]": "customer.subscription.deleted",
    }),
  });

  const webhook = await response.json();
  
  if (webhook.error) {
    throw new Error(`Failed to create webhook: ${webhook.error.message}`);
  }

  console.log(`✅ Webhook created: ${webhook.id}`);
  return webhook.secret;
}

async function main() {
  console.log("🚀 Ground Truth - Stripe Setup\n");

  try {
    // Step 1: Create product
    const productId = await createProduct();
    
    // Step 2: Create price
    const priceId = await createPrice(productId);
    
    // Step 3: Create webhook
    const webhookSecret = await createWebhook();
    
    console.log("\n✅ Setup complete!\n");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("\n📝 Next steps:\n");
    console.log("1. Update src/index.ts:");
    console.log(`   Replace "price_placeholder" with "${priceId}"\n`);
    
    console.log("2. Set Cloudflare Worker secrets:");
    console.log(`   npx wrangler secret put STRIPE_SECRET_KEY`);
    console.log(`   (paste your Stripe secret key)\n`);
    console.log(`   npx wrangler secret put STRIPE_WEBHOOK_SECRET`);
    console.log(`   (paste: ${webhookSecret})\n`);
    
    console.log("3. Create KV namespace:");
    console.log(`   npx wrangler kv namespace create API_KEYS`);
    console.log(`   Then update wrangler.jsonc with the returned ID\n`);
    
    console.log("4. Test locally:");
    console.log(`   npx wrangler dev\n`);
    
    console.log("5. Deploy:");
    console.log(`   npx wrangler deploy\n`);
    
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("\n🔑 Save these for reference:");
    console.log(`Product ID: ${productId}`);
    console.log(`Price ID: ${priceId}`);
    console.log(`Webhook Secret: ${webhookSecret}`);
    
  } catch (error) {
    console.error("\n❌ Setup failed:", error.message);
    process.exit(1);
  }
}

main();
