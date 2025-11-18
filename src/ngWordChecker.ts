import { Request, Response, NextFunction } from 'express';
import { db } from './database';

interface LLMCheckResult {
  blocked: boolean;
  matched_word: string | null;
  reason: string;
}

export class NGWordChecker {
  private ngWords: string[] = [];
  private geminiApiKey: string | null = null;
  private llmCheckEnabled: boolean = false;

  constructor() {
    this.loadNGWords();
    this.geminiApiKey = process.env.GEMINI_API_KEY || null;
    this.llmCheckEnabled = process.env.LLM_CHECK_ENABLED?.toLowerCase() === 'true';
  }

  private loadNGWords() {
    // Load NG words from database
    const ngWordsFromDb = db.getAllNGWords();
    this.ngWords = ngWordsFromDb.map(item => item.word);
  }

  public checkContent(content: string): string | null {
    const lowerContent = content.toLowerCase();

    for (const ngWord of this.ngWords) {
      const lowerNgWord = ngWord.toLowerCase();
      if (lowerContent.includes(lowerNgWord)) {
        return ngWord;
      }
    }

    return null;
  }

  private async checkWithLLM(content: string): Promise<LLMCheckResult> {
    if (!this.geminiApiKey || this.ngWords.length === 0) {
      return { blocked: false, matched_word: null, reason: '' };
    }

    const timestamp = new Date().toISOString();
    const startTime = Date.now();
    const ngWordsChecked = this.ngWords.join(', ');

    const prompt = `あなたはコンテンツモデレーターです。以下のNGワードリストに関連する内容がユーザーメッセージに含まれているか判定してください。

判定基準:
- 完全一致だけでなく、略語、言い換え、隠語、当て字、ネットスラングも検出対象です
- 例: 「青山学院」→「青学」「青山」、「死」→「タヒ」「氏」「4」など
- NGワードの概念や話題に触れている場合もブロック対象です

NGワードリスト: ${ngWordsChecked}

ユーザーメッセージ: ${content}

以下のJSON形式のみで回答してください（説明文は不要）:
{"blocked": true または false, "matched_word": "検出されたNGワード（なければnull）", "reason": "判定理由（日本語で簡潔に）"}`;

    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent?key=${this.geminiApiKey}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            contents: [
              {
                parts: [
                  {
                    text: prompt
                  }
                ]
              }
            ],
            generationConfig: {
              temperature: 0.1,
              maxOutputTokens: 256,
            }
          })
        }
      );

      const duration = Date.now() - startTime;

      if (!response.ok) {
        console.error(`Gemini API error: ${response.status} ${response.statusText}`);
        // Save failed request to database
        db.insertLLMRequest({
          timestamp,
          request_content: content.substring(0, 500),
          ng_words_checked: ngWordsChecked,
          blocked: false,
          reason: `API error: ${response.status}`,
          duration
        });
        return { blocked: false, matched_word: null, reason: 'API error' };
      }

      const data = await response.json() as {
        candidates?: Array<{
          content?: {
            parts?: Array<{
              text?: string;
            }>;
          };
        }>;
      };
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

      // Parse JSON from response
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const result = JSON.parse(jsonMatch[0]) as LLMCheckResult;

        // Save request to database
        db.insertLLMRequest({
          timestamp,
          request_content: content.substring(0, 500),
          ng_words_checked: ngWordsChecked,
          blocked: result.blocked,
          matched_word: result.matched_word || undefined,
          reason: result.reason,
          duration
        });

        return result;
      }

      // Save parse error to database
      db.insertLLMRequest({
        timestamp,
        request_content: content.substring(0, 500),
        ng_words_checked: ngWordsChecked,
        blocked: false,
        reason: 'Parse error',
        duration
      });

      return { blocked: false, matched_word: null, reason: 'Parse error' };
    } catch (error) {
      const duration = Date.now() - startTime;
      console.error('LLM check error:', error);

      // Save error to database
      db.insertLLMRequest({
        timestamp,
        request_content: content.substring(0, 500),
        ng_words_checked: ngWordsChecked,
        blocked: false,
        reason: `Error: ${error}`,
        duration
      });

      return { blocked: false, matched_word: null, reason: 'Error' };
    }
  }

  public middleware() {
    return async (req: Request, res: Response, next: NextFunction) => {
      const timestamp = new Date().toISOString();
      let requestContent = '';

      try {
        // Extract content from request body
        if (req.body) {
          if (req.body.messages && Array.isArray(req.body.messages)) {
            // Check ONLY the LATEST user message (not the entire conversation history)
            const userMessages = req.body.messages.filter((msg: any) => msg.role === 'user');

            if (userMessages.length === 0) {
              return next();
            }

            const latestUserMessage = userMessages[userMessages.length - 1];

            if (!latestUserMessage.content) {
              return next();
            }

            // Handle string content
            if (typeof latestUserMessage.content === 'string') {
              requestContent = latestUserMessage.content;
            }
            // Handle array content (multimodal)
            else if (Array.isArray(latestUserMessage.content)) {
              requestContent = latestUserMessage.content
                .map((item: any) => {
                  if (item.type === 'text' && item.text) {
                    return item.text;
                  }
                  return '';
                })
                .join(' ');
            } else {
              return next();
            }
          } else if (req.body.prompt) {
            requestContent = req.body.prompt;
          } else {
            // No user content to check, skip NG word filtering
            return next();
          }

          // First check: keyword matching (fast)
          let foundNGWord = this.checkContent(requestContent);
          let blockedByLLM = false;
          let llmReason = '';

          // Second check: LLM-based detection (if keyword match didn't find anything)
          if (!foundNGWord && this.geminiApiKey && this.llmCheckEnabled) {
            const llmResult = await this.checkWithLLM(requestContent);
            if (llmResult.blocked) {
              foundNGWord = llmResult.matched_word;
              blockedByLLM = true;
              llmReason = llmResult.reason;
              console.log(`\n🤖 LLM detected NG content: "${foundNGWord}" - ${llmReason}`);
            }
          }

          if (foundNGWord) {
            console.log(`\n🚫 NG WORD BLOCKED: "${foundNGWord}"${blockedByLLM ? ' (LLM)' : ''}`);
            console.log(`   Path: ${req.path}`);
            console.log(`   Content: ${requestContent.substring(0, 100)}...`);
            if (llmReason) {
              console.log(`   Reason: ${llmReason}`);
            }
          }

          if (foundNGWord) {
            // Log blocked request to database
            const dbId = db.insertRequest({
              timestamp,
              method: req.method,
              path: req.path,
              headers: JSON.stringify(req.headers),
              query: JSON.stringify(req.query),
              requestBody: JSON.stringify(req.body)
            });

            // Create a friendly response message
            const detectionMethod = blockedByLLM ? `（LLM検出: ${llmReason}）` : '';
            const friendlyMessage = `申し訳ございません。このリクエストには不適切な表現（「${foundNGWord}」）が含まれているため、処理できませんでした。${detectionMethod}\n\n別の表現で質問していただけますか？`;

            // Check if streaming is requested
            const isStreaming = req.body.stream === true;

            if (isStreaming) {
              // Return Server-Sent Events (SSE) format for streaming
              res.setHeader('Content-Type', 'text/event-stream');
              res.setHeader('Cache-Control', 'no-cache');
              res.setHeader('Connection', 'keep-alive');

              const streamId = `blocked-${Date.now()}`;
              const timestamp = Math.floor(Date.now() / 1000);

              // Send the message as a streaming chunk
              const chunk = {
                id: streamId,
                object: 'chat.completion.chunk',
                created: timestamp,
                model: req.body.model || 'unknown',
                choices: [
                  {
                    index: 0,
                    delta: {
                      role: 'assistant',
                      content: friendlyMessage
                    },
                    finish_reason: null
                  }
                ]
              };

              // Send the content chunk
              res.write(`data: ${JSON.stringify(chunk)}\n\n`);

              // Send the final chunk with finish_reason
              const finalChunk = {
                id: streamId,
                object: 'chat.completion.chunk',
                created: timestamp,
                model: req.body.model || 'unknown',
                choices: [
                  {
                    index: 0,
                    delta: {},
                    finish_reason: 'stop'
                  }
                ]
              };

              res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
              res.write('data: [DONE]\n\n');

              db.updateResponse(dbId, {
                statusCode: 200,
                responseHeaders: JSON.stringify({ 'content-type': 'text/event-stream' }),
                responseBody: friendlyMessage,
                duration: 0,
                error: `Blocked by NG word: ${foundNGWord}${blockedByLLM ? ' (LLM)' : ''}`
              });

              return res.end();
            } else {
              // Return normal JSON format for non-streaming
              const blockedResponse = {
                id: `blocked-${Date.now()}`,
                object: 'chat.completion',
                created: Math.floor(Date.now() / 1000),
                model: req.body.model || 'unknown',
                choices: [
                  {
                    index: 0,
                    message: {
                      role: 'assistant',
                      content: friendlyMessage
                    },
                    finish_reason: 'stop'
                  }
                ],
                usage: {
                  prompt_tokens: 0,
                  completion_tokens: 0,
                  total_tokens: 0
                }
              };

              db.updateResponse(dbId, {
                statusCode: 200,
                responseHeaders: JSON.stringify({ 'content-type': 'application/json' }),
                responseBody: JSON.stringify(blockedResponse),
                duration: 0,
                error: `Blocked by NG word: ${foundNGWord}${blockedByLLM ? ' (LLM)' : ''}`
              });

              return res.status(200).json(blockedResponse);
            }
          }
        }
      } catch (error) {
        console.error('Error in NG word checker:', error);
      }

      // Continue to proxy if no NG words found
      next();
    };
  }

  public getNGWords(): string[] {
    return [...this.ngWords];
  }

  public reloadNGWords() {
    this.loadNGWords();
  }

  public hasLLMSupport(): boolean {
    return !!this.geminiApiKey && this.llmCheckEnabled;
  }

  public getLLMStatus(): { enabled: boolean; hasApiKey: boolean; active: boolean } {
    return {
      enabled: this.llmCheckEnabled,
      hasApiKey: !!this.geminiApiKey,
      active: this.llmCheckEnabled && !!this.geminiApiKey
    };
  }
}

export const ngWordChecker = new NGWordChecker();
