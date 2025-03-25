#!/usr/bin/env node

/**
 * Devin MCP Server with Slack Integration
 * 
 * This server provides MCP tools for interacting with Devin AI and integrates with Slack.
 * It uses environment variables for configuration, which can be set directly or through config files:
 * 
 * - DEVIN_API_KEY: Required. API key for Devin.
 * - DEVIN_ORG_NAME: Optional. Organization name (default: "Default Organization")
 * - DEVIN_BASE_URL: Optional. Base URL for Devin API (default: "https://api.devin.ai/v1")
 * - SLACK_BOT_TOKEN: Required for Slack integration. Slack Bot User OAuth Token.
 * - SLACK_DEFAULT_CHANNEL: Required for Slack integration. Default channel ID to post to.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { WebClient } from "@slack/web-api";
import axios from "axios";
import config from "./config.js";

// Configuration for Devin API
const API_KEY = config.devin.apiKey;
const ORG_NAME = config.devin.orgName;
const BASE_URL = config.devin.baseUrl;

// Configuration for Slack API
const SLACK_TOKEN = config.slack.token;
const SLACK_DEFAULT_CHANNEL = config.slack.defaultChannel;

// Required configuration validation
if (!API_KEY) {
  console.error("Error: DEVIN_API_KEY is not set");
  process.exit(1);
}

if (!SLACK_TOKEN) {
  console.error("Error: SLACK_BOT_TOKEN is not set");
  process.exit(1);
}

if (!SLACK_DEFAULT_CHANNEL) {
  console.error("Error: SLACK_DEFAULT_CHANNEL is not set");
  process.exit(1);
}

// Initialize Slack client
const slackClient = new WebClient(SLACK_TOKEN);

/**
 * セッションIDから'devin-'接頭辞を取り除く関数
 */
function normalizeSessionId(sessionId: string): string {
  return sessionId.replace(/^devin-/, '');
}

/**
 * チャンネル名またはIDからチャンネルIDを取得
 * チャンネル名が指定された場合は検索して対応するIDを返す
 * すでにIDの場合はそのまま返す
 */
async function getChannelId(channelNameOrId: string): Promise<string> {
  // すでにIDの場合 (C12345 形式)
  if (/^[C][A-Z0-9]{8,}$/.test(channelNameOrId)) {
    return channelNameOrId;
  }
  
  try {
    // チャンネル名の場合、一覧を取得して検索
    const result = await slackClient.conversations.list();
    if (result.channels && Array.isArray(result.channels)) {
      // チャンネル名で検索 (#は省略可能)
      const normalizedName = channelNameOrId.startsWith('#') ? 
        channelNameOrId.substring(1) : channelNameOrId;
      
      const channel = result.channels.find(
        (ch) => ch.name === normalizedName
      );
      
      if (channel && channel.id) {
        return channel.id;
      }
    }
    
    // 見つからない場合はエラー
    throw new Error(`Channel not found: ${channelNameOrId}`);
  } catch (error) {
    console.error(`Error resolving channel name to ID: ${error}`);
    throw error;
  }
}

// サーバー設定
const server = new Server(
  {
    name: `devin-${ORG_NAME}`,
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

/**
 * リクエストヘッダー作成ヘルパー
 */
const getHeaders = () => ({
  Authorization: `Bearer ${API_KEY}`,
  "Content-Type": "application/json",
});

/**
 * ツール一覧の定義
 */
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "create_devin_session",
        description: "Create a new Devin session for code development and post the task to Slack. Note: This is the recommended approach as it will automatically post your task to Slack as @Devin mention. Please craft your request to Devin in the same language that the user is using to communicate with you, maintaining language consistency throughout the experience.",
        inputSchema: {
          type: "object",
          properties: {
            prompt: {
              type: "string",
              description: "Task description for Devin"
            },
            machine_snapshot_id: {
              type: "string",
              description: "Optional machine snapshot ID"
            },
            max_acu: {
              type: "number",
              description: "Optional compute limit override"
            },
            idempotent: {
              type: "boolean",
              description: "Enable idempotent session creation"
            },
            slack_channel: {
              type: "string",
              description: "Optional Slack channel ID to post to (default: from config)"
            }
          },
          required: ["prompt"]
        }
      },
      {
        name: "get_devin_session",
        description: "Get information about an existing Devin session and optionally fetch associated Slack messages",
        inputSchema: {
          type: "object",
          properties: {
            session_id: {
              type: "string",
              description: "The ID of the Devin session"
            },
            fetch_slack_info: {
              type: "boolean",
              description: "Whether to fetch associated Slack messages (if available)"
            }
          },
          required: ["session_id"]
        }
      },
      {
        name: "list_devin_sessions",
        description: "List all Devin sessions",
        inputSchema: {
          type: "object",
          properties: {
            limit: {
              type: "number",
              description: "Maximum number of sessions to return"
            },
            offset: {
              type: "number",
              description: "Number of sessions to skip"
            }
          }
        }
      },
      {
        name: "send_message_to_session",
        description: "Send a message to an existing Devin session and optionally to the associated Slack thread",
        inputSchema: {
          type: "object",
          properties: {
            session_id: {
              type: "string",
              description: "The ID of the Devin session"
            },
            message: {
              type: "string",
              description: "Message to send to Devin"
            },
            slack_channel: {
              type: "string",
              description: "Optional Slack channel ID to post to"
            },
            slack_thread_ts: {
              type: "string",
              description: "Optional Slack thread timestamp to reply to"
            }
          },
          required: ["session_id", "message"]
        }
      },
      {
        name: "get_organization_info",
        description: "Get information about the current Devin organization",
        inputSchema: {
          type: "object",
          properties: {}
        }
      }
    ]
  };
});

/**
 * Send a message to Slack channel
 */
async function sendSlackMessage(channel: string, text: string, threadTs?: string) {
  try {
    // チャンネルIDを解決
    const channelId = await getChannelId(channel);
    
    const messageOptions = {
      channel: channelId,
      text,
      thread_ts: threadTs,
      as_user: true
    };

    const response = await slackClient.chat.postMessage(messageOptions);
    return response;
  } catch (error) {
    console.error('Error sending message to Slack:', error);
    throw error;
  }
}

/**
 * ツール実行ハンドラー
 */
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  switch (request.params.name) {
    // セッション作成
    case "create_devin_session": {
      const prompt = String(request.params.arguments?.prompt);
      const machine_snapshot_id = request.params.arguments?.machine_snapshot_id as string | undefined;
      const max_acu = Number(request.params.arguments?.max_acu) || undefined;
      const idempotent = Boolean(request.params.arguments?.idempotent) || false;
      const slack_channel = request.params.arguments?.slack_channel as string || SLACK_DEFAULT_CHANNEL;

      if (!prompt) {
        return {
          content: [{
            type: "text",
            text: "Error: prompt is required"
          }],
          isError: true
        };
      }

      try {
        // Create Devin session
        const requestBody: Record<string, any> = {
          prompt,
          idempotent
        };

        if (machine_snapshot_id) {
          requestBody.machine_snapshot_id = machine_snapshot_id;
        }

        if (max_acu) {
          requestBody.max_acu = max_acu;
        }

        const response = await axios.post(
          `${BASE_URL}/session`,
          requestBody,
          { headers: getHeaders() }
        );

        // Find the Devin user ID in Slack
        let devinUserId = "";
        try {
          // Devinユーザーを検索
          const result = await slackClient.users.list();
          if (result.members && Array.isArray(result.members)) {
            const devinUser = result.members.find(user => 
              user.name === "devin" || 
              user.real_name === "Devin" || 
              user.profile?.display_name === "Devin"
            );
            
            if (devinUser && devinUser.id) {
              devinUserId = devinUser.id;
            }
          }
        } catch (userError) {
          console.error('Error finding Devin user:', userError);
        }

        // Post task to Slack channel with proper mention
        let slackMessage = "";
        if (devinUserId) {
          // 正しいメンション形式を使用
          slackMessage = `<@${devinUserId}> ${prompt}`;
        } else {
          // Devinユーザーが見つからない場合はフォールバック
          slackMessage = `@Devin ${prompt}`;
        }
        
        const slackResponse = await sendSlackMessage(slack_channel, slackMessage);
        
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              session_id: normalizeSessionId(response.data.session_id),
              original_session_id: response.data.session_id,
              url: response.data.url,
              organization: ORG_NAME,
              is_new_session: response.data.is_new_session,
              slack_message_ts: slackResponse.ts,
              slack_channel: slack_channel
            }, null, 2)
          }]
        };
      } catch (error) {
        if (axios.isAxiosError(error)) {
          return {
            content: [{
              type: "text",
              text: `Error creating session: ${error.response?.status} - ${JSON.stringify(error.response?.data)}`
            }],
            isError: true
          };
        }
        
        return {
          content: [{
            type: "text",
            text: `Unexpected error: ${error}`
          }],
          isError: true
        };
      }
    }

    // セッション情報取得
    case "get_devin_session": {
      const session_id = String(request.params.arguments?.session_id);
      const fetch_slack_info = Boolean(request.params.arguments?.fetch_slack_info);

      if (!session_id) {
        return {
          content: [{
            type: "text",
            text: "Error: session_id is required"
          }],
          isError: true
        };
      }

      try {
        // Get session info from Devin API
        const response = await axios.get(
          `${BASE_URL}/session/${normalizeSessionId(session_id)}`,
          { headers: getHeaders() }
        );
        
        // If requested, try to fetch additional Slack info about this session
        let data = response.data;
        
        if (fetch_slack_info) {
          try {
            // This is a simplified approach - in a real implementation you would need
            // to store the slack_channel and slack_message_ts in a database associated with the session_id
            const sessionResponse = await axios.get(
              `${BASE_URL}/session/${normalizeSessionId(session_id)}/message`,
              { headers: getHeaders() }
            );
            
            data = {
              ...data,
              messages: sessionResponse.data.messages
            };
          } catch (slackError) {
            console.error('Error fetching Slack info:', slackError);
          }
        }

        // セッションIDを正規化して返す
        if (data && data.session_id) {
          data = {
            ...data,
            original_session_id: data.session_id,
            session_id: normalizeSessionId(data.session_id)
          };
        }

        return {
          content: [{
            type: "text",
            text: JSON.stringify(data, null, 2)
          }]
        };
      } catch (error) {
        if (axios.isAxiosError(error)) {
          return {
            content: [{
              type: "text",
              text: `Error getting session: ${error.response?.status} - ${JSON.stringify(error.response?.data)}`
            }],
            isError: true
          };
        }
        
        return {
          content: [{
            type: "text",
            text: `Unexpected error: ${error}`
          }],
          isError: true
        };
      }
    }

    // セッションへメッセージ送信
    case "send_message_to_session": {
      const session_id = String(request.params.arguments?.session_id);
      const message = String(request.params.arguments?.message);
      const slack_channel = request.params.arguments?.slack_channel as string | undefined;
      const slack_thread_ts = request.params.arguments?.slack_thread_ts as string | undefined;

      if (!session_id) {
        return {
          content: [{
            type: "text",
            text: "Error: session_id is required"
          }],
          isError: true
        };
      }

      if (!message) {
        return {
          content: [{
            type: "text",
            text: "Error: message is required"
          }],
          isError: true
        };
      }

      try {
        // Send message to Devin API
        // Devin APIへメッセージ送信
        const response = await axios.post(
          `${BASE_URL}/session/${normalizeSessionId(session_id)}/message`,
          { message },
          { headers: getHeaders() }
        );
        
        // APIレスポンスの詳細なチェック
        // HTTP 200系のステータスが返ってきたら基本的に成功とみなす
        // 空のオブジェクトが返る場合も成功と判断する
        const isSuccess = response.status >= 200 && response.status < 300;
        
        let slackResponse = null;
        // Slackスレッド情報が提供されていれば、Slackにも送信
        if (isSuccess && slack_channel && slack_thread_ts) {
          slackResponse = await sendSlackMessage(slack_channel, message, slack_thread_ts);
        }

        if (isSuccess) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                status: "Message sent successfully",
                success: true,
                response_data: response.data || {},
                slack_response: slackResponse ? {
                  channel: slack_channel,
                  thread_ts: slack_thread_ts,
                  message_ts: slackResponse.ts
                } : null
              }, null, 2)
            }]
          };
        } else {
          // APIレスポンスが成功しなかった場合
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                status: "Message sending failed",
                success: false,
                http_status: response.status,
                response_data: response.data || {}
              }, null, 2)
            }],
            isError: true
          };
        }
      } catch (error) {
        if (axios.isAxiosError(error)) {
          return {
            content: [{
              type: "text",
              text: `Error sending message: ${error.response?.status} - ${JSON.stringify(error.response?.data)}`
            }],
            isError: true
          };
        }
        
        return {
          content: [{
            type: "text",
            text: `Unexpected error: ${error}`
          }],
          isError: true
        };
      }
    }

    // セッション一覧取得
    case "list_devin_sessions": {
      const limit = Number(request.params.arguments?.limit) || undefined;
      const offset = Number(request.params.arguments?.offset) || undefined;

      try {
        const params: Record<string, any> = {};
        if (limit !== undefined) params.limit = limit;
        if (offset !== undefined) params.offset = offset;

        const response = await axios.get(
          `${BASE_URL}/session`,
          { 
            params,
            headers: getHeaders()
          }
        );
        
        // セッション一覧の各セッションIDを正規化する
        const normalizedData = { ...response.data };
        if (normalizedData.sessions && Array.isArray(normalizedData.sessions)) {
          normalizedData.sessions = normalizedData.sessions.map((session: { session_id?: string; [key: string]: any }) => {
            if (session.session_id) {
              return {
                ...session,
                original_session_id: session.session_id,
                session_id: normalizeSessionId(session.session_id)
              };
            }
            return session;
          });
        }
        
        return {
          content: [{
            type: "text",
            text: JSON.stringify(normalizedData, null, 2)
          }]
        };
      } catch (error) {
        if (axios.isAxiosError(error)) {
          return {
            content: [{
              type: "text",
              text: `Error listing sessions: ${error.response?.status} - ${JSON.stringify(error.response?.data)}`
            }],
            isError: true
          };
        }
        
        return {
          content: [{
            type: "text",
            text: `Unexpected error: ${error}`
          }],
          isError: true
        };
      }
    }

    // 組織情報取得
    case "get_organization_info": {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            name: ORG_NAME,
            base_url: BASE_URL,
          }, null, 2)
        }]
      };
    }

    default:
      return {
        content: [{
          type: "text",
          text: `Unknown tool: ${request.params.name}`
        }],
        isError: true
      };
  }
});

/**
 * サーバー起動
 */
async function main() {
  const transport = new StdioServerTransport();
  console.error(`Starting Devin MCP Server for ${ORG_NAME}...`);
  await server.connect(transport);
  console.error(`Devin MCP Server for ${ORG_NAME} is running on stdio`);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
