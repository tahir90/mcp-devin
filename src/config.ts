/**
 * Default configuration for MCP Devin with Slack integration
 * 
 * This file contains the default configuration values.
 * Configuration is primarily sourced from environment variables.
 */

const config = {
  // Devin API settings
  devin: {
    apiKey: process.env.DEVIN_API_KEY,
    orgName: process.env.DEVIN_ORG_NAME || "Default Organization",
    baseUrl: process.env.DEVIN_BASE_URL || "https://api.devin.ai/v1"
  },
  // Slack API settings
  slack: {
    token: process.env.SLACK_BOT_TOKEN,
    defaultChannel: process.env.SLACK_DEFAULT_CHANNEL
  }
};

export default config;
