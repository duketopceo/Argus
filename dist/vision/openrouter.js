import { debug } from '../debug.js';
import { makeCallCost } from './cost.js';
export class OpenRouterClient {
    _apiKey;
    _fetch;
    _trace;
    _headers;
    _onCall;
    constructor(opts) {
        if (!opts.apiKey) {
            throw new Error('OPENROUTER_API_KEY is required: pass a non-empty apiKey at construction');
        }
        this._apiKey = opts.apiKey;
        this._fetch = opts.fetch ?? globalThis.fetch;
        this._trace = opts.trace;
        this._headers = opts.headers;
        this._onCall = opts.onCall;
    }
    async complete(opts) {
        const candidates = [opts.model, ...(opts.escalationModels ?? [])];
        const errors = [];
        const kind = opts.kind ?? 'ground';
        debug('openrouter', `kind=${kind} candidates=[${candidates.join(', ')}] messages=${opts.messages.length}`);
        for (let i = 0; i < candidates.length; i++) {
            const model = candidates[i];
            if (model === undefined)
                continue;
            const remaining = candidates.slice(i + 1);
            try {
                const response = await this._tryComplete({
                    model,
                    messages: opts.messages,
                    ...(opts.schema !== undefined ? { schema: opts.schema } : {}),
                    ...(opts.provider !== undefined ? { provider: opts.provider } : {}),
                    models: remaining,
                    kind,
                });
                const cost = makeCallCost(response, kind);
                debug('openrouter', `model=${response.model} tokens=${cost.tokens} costUsd=${cost.costUsd.toFixed(6)} content_len=${this._extractContent(response).length}`);
                this._onCall?.({
                    id: response.id,
                    model: response.model,
                    kind,
                    costUsd: cost.costUsd,
                    tokens: cost.tokens,
                    ...(this._trace ? { trace: this._trace } : {}),
                });
                return { id: response.id, content: this._extractContent(response), cost, model: response.model };
            }
            catch (e) {
                const err = e;
                debug('openrouter', `candidate ${model} failed: ${err.message}`);
                errors.push(err);
            }
        }
        throw new Error(`OpenRouter completion failed for all candidate models: ${errors.map((e) => e.message).join('; ')}`);
    }
    async reconcile(id) {
        const res = await this._fetch(`https://openrouter.ai/api/v1/generation?id=${encodeURIComponent(id)}`, {
            method: 'GET',
            headers: { Authorization: `Bearer ${this._apiKey}` },
        });
        if (!res.ok) {
            throw new Error(`OpenRouter generation reconcile failed: ${res.status} ${res.statusText}`);
        }
        const data = (await res.json());
        const total = data.data?.total_cost ?? data.total_cost ?? 0;
        return { costUsd: total };
    }
    async _tryComplete(req) {
        const body = {
            model: req.model,
            messages: this._toApiMessages(req.messages),
        };
        if (req.provider) {
            body.provider = req.provider;
        }
        if (req.models && req.models.length > 0) {
            body.models = req.models;
        }
        if (req.schema) {
            body.response_format = {
                type: 'json_schema',
                json_schema: {
                    name: req.schema.name,
                    schema: req.schema.schema,
                    strict: req.schema.strict ?? true,
                },
            };
        }
        if (this._trace) {
            body.trace = this._trace;
        }
        const headers = {
            Authorization: `Bearer ${this._apiKey}`,
            'Content-Type': 'application/json',
            'X-Title': 'argus-reviewer',
            'X-OpenRouter-Metadata': 'enabled',
            ...(this._headers ?? {}),
        };
        const res = await this._fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
        });
        if (!res.ok) {
            throw new Error(`OpenRouter request failed: ${res.status} ${res.statusText}`);
        }
        return (await res.json());
    }
    _toApiMessages(messages) {
        return messages.map((m) => ({
            role: m.role,
            content: m.content
                .map((part) => {
                if (part.type === 'text') {
                    return { type: 'text', text: part.text };
                }
                return {
                    type: 'image_url',
                    image_url: { url: `data:image/jpeg;base64,${part.source}` },
                };
            })
                .sort((a) => (a.type === 'text' ? -1 : 1)),
        }));
    }
    _extractContent(response) {
        const first = response.choices[0];
        const content = first?.message?.content;
        if (typeof content === 'string')
            return content;
        return '';
    }
}
