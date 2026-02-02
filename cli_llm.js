// cli_llm.js

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const AUTH_STATE_PATH = path.join(__dirname, 'auth_state.json');

const DEFAULT_TIMEOUT_MS = 120000;

function getProviderModel(provider) {
    try {
        if (fs.existsSync(AUTH_STATE_PATH)) {
            const state = JSON.parse(fs.readFileSync(AUTH_STATE_PATH, 'utf-8'));
            if (state.models && state.models[provider]) return state.models[provider];
        }
    } catch {
        // ignore and fall back to defaults
    }
    if (provider === 'codex') return 'gpt-5.1-codex-mini';
    if (provider === 'gemini') return 'gemini-3-flash';
    return '';
}

function execFilePromise(command, args, options = {}) {
    return new Promise((resolve, reject) => {
        execFile(command, args, { maxBuffer: 10 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
            if (error) {
                error.stdout = stdout;
                error.stderr = stderr;
                return reject(error);
            }
            resolve({ stdout, stderr });
        });
    });
}

function extractJson(text) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) return null;
    const candidate = text.slice(start, end + 1);
    try {
        return JSON.parse(candidate);
    } catch {
        return null;
    }
}

async function runCodex(prompt, { schema, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-codex-'));
    const outputPath = path.join(tempDir, 'output.txt');
    const model = getProviderModel('codex');
    const args = [
        'exec',
        '--sandbox',
        'read-only',
        '--skip-git-repo-check',
        '--color',
        'never',
        '-o',
        outputPath,
    ];

    if (model) {
        args.push('--model', model);
    }

    if (schema) {
        const schemaPath = path.join(tempDir, 'schema.json');
        fs.writeFileSync(schemaPath, JSON.stringify(schema, null, 2));
        args.push('--output-schema', schemaPath);
    }

    args.push(prompt);

    await execFilePromise('codex', args, { timeout: timeoutMs });
    return fs.readFileSync(outputPath, 'utf-8').trim();
}

async function runGemini(prompt, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const model = getProviderModel('gemini');
    const buildArgs = (useModel) => {
        const args = [];
        if (useModel && model) {
            args.push('--model', model);
        }
        args.push('-p', prompt);
        return args;
    };

    try {
        const { stdout } = await execFilePromise('gemini', buildArgs(true), { timeout: timeoutMs });
        return stdout.trim();
    } catch (error) {
        const combined = `${error.stderr || ''}\n${error.stdout || ''}`.trim();
        if (model && /ModelNotFoundError|Requested entity was not found/i.test(combined)) {
            const { stdout } = await execFilePromise('gemini', buildArgs(false), { timeout: timeoutMs });
            return stdout.trim();
        }
        throw new Error(combined || error.message);
    }
}

module.exports = { runCodex, runGemini, extractJson };
