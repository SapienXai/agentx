// mcp_client.js

const path = require('path');

async function createChromeDevtoolsMcpClient(options = {}) {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');

    const config = {
        headless: Boolean(options.headless),
        browserUrl: options.browserUrl ? String(options.browserUrl) : ''
    };
    const args = ['-y', 'chrome-devtools-mcp@latest'];
    if (config.headless) args.push('--headless');
    if (config.browserUrl) args.push(`--browser-url=${config.browserUrl}`);

    const transport = new StdioClientTransport({
        command: 'npx',
        args,
        cwd: path.resolve(__dirname),
    });

    const client = new Client({ name: 'agentx', version: '1.0.0' });
    await client.connect(transport);

    const tools = await client.listTools();
    return { client, tools };
}

async function fetchChromeDevtoolsToolCatalog(options = {}) {
    const { client, tools } = await createChromeDevtoolsMcpClient(options);
    await client.close();
    return tools;
}

module.exports = { createChromeDevtoolsMcpClient, fetchChromeDevtoolsToolCatalog };
