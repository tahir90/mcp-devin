#!/usr/bin/env node

/**
 * Devin MCP Server
 * 
 * This server provides MCP tools for interacting with Devin AI.
 * It uses environment variables for configuration:
 * 
 * - DEVIN_API_KEY: Required. API key for Devin.
 * - DEVIN_ORG_NAME: Optional. Organization name (default: "Default Organization")
 * - DEVIN_BASE_URL: Optional. Base URL for Devin API (default: "https://api.devin.ai/v1")
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import axios from "axios";

// 環境変数から設定を取得
const API_KEY = process.env.DEVIN_API_KEY;
const ORG_NAME = process.env.DEVIN_ORG_NAME || "Default Organization";
const BASE_URL = process.env.DEVIN_BASE_URL || "https://api.devin.ai/v1";

// APIキーの確認
if (!API_KEY) {
  console.error("Error: DEVIN_API_KEY environment variable not set");
  process.exit(1);
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
        description: "Create a new Devin session for code development",
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
            }
          },
          required: ["prompt"]
        }
      },
      {
        name: "get_devin_session",
        description: "Get information about an existing Devin session",
        inputSchema: {
          type: "object",
          properties: {
            session_id: {
              type: "string",
              description: "The ID of the Devin session"
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
        description: "Send a message to an existing Devin session",
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
          `${BASE_URL}/sessions`,
          requestBody,
          { headers: getHeaders() }
        );

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              session_id: response.data.session_id,
              url: response.data.url,
              organization: ORG_NAME,
              is_new_session: response.data.is_new_session,
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
        const response = await axios.get(
          `${BASE_URL}/session/${session_id}`,
          { headers: getHeaders() }
        );
        
        return {
          content: [{
            type: "text",
            text: JSON.stringify(response.data, null, 2)
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
        const response = await axios.post(
          `${BASE_URL}/session/${session_id}/message`,
          { message },
          { headers: getHeaders() }
        );
        
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              session_id,
              message_sent: message,
              response: response.data
            }, null, 2)
          }]
        };
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
          `${BASE_URL}/sessions`,
          { 
            params,
            headers: getHeaders()
          }
        );
        
        return {
          content: [{
            type: "text",
            text: JSON.stringify(response.data, null, 2)
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
