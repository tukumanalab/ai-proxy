import { Request, Response, NextFunction } from 'express';
import { db } from './database';

export class NGWordChecker {
  private ngWords: string[] = [];

  constructor() {
    this.loadNGWords();
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

  public middleware() {
    return (req: Request, res: Response, next: NextFunction) => {
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

          // Check for NG words only if we have content
          const foundNGWord = this.checkContent(requestContent);

          if (foundNGWord) {
            console.log(`\n🚫 NG WORD BLOCKED: "${foundNGWord}"`);
            console.log(`   Path: ${req.path}`);
            console.log(`   Content: ${requestContent.substring(0, 100)}...`);
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
            const friendlyMessage = `申し訳ございません。このリクエストには不適切な表現（「${foundNGWord}」）が含まれているため、処理できませんでした。\n\n別の表現で質問していただけますか？`;

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
                error: `Blocked by NG word: ${foundNGWord}`
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
                error: `Blocked by NG word: ${foundNGWord}`
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
}

export const ngWordChecker = new NGWordChecker();
