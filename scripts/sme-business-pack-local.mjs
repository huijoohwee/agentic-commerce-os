import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { invokeSmePackTool, smePackFailure, smeToolResult, TOOL_SCHEMAS } from '../public/local-first/sme-business-pack-core.js'

const server = new Server({ name: 'sme-business-pack', version: '0.9.2' }, { capabilities: { tools: {} } })
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOL_SCHEMAS.map(tool => ({ ...tool,
    description: `${tool.name} · local Singapore SME pack · no network or persistence`,
  })),
}))
server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  try {
    const value = await invokeSmePackTool(params.name, params.arguments ?? {})
    return smeToolResult(value)
  } catch (error) {
    const failure = smePackFailure(error)
    return { isError: true, structuredContent: failure, content: [{ type: 'text', text: failure.reasons ? JSON.stringify(failure) : failure.code }] }
  }
})

await server.connect(new StdioServerTransport())
