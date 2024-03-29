const config = require("../config");
const express = require('express');
const path = require('path');
const EventEmitter = require('events');
const logger = require('./log');

async function completions(browser) {
    const browserManager = new BrowserManager(browser);
    await browserManager.initPages(config.process_workers);

    const app = express();
    const PORT = 8081;
    app.use(express.json());
    app.listen(PORT, () => {
        logger.info(`Server is running on http://localhost:${PORT}`);
    });


    app.post('/v1/chat/completions', async (req, res) => {
        logger.info("New Request");
        const chatGPTPage = await browserManager.getFreePage();
        try {
            logger.info("model: " + req.body.model);
            logger.info("message: " + JSON.stringify(req.body.messages));
            await chatGPTPage.evaluate(async (reqbody) => {
                await chatgpt.sendInNewChat(JSON.stringify(reqbody.messages));
            }, req.body);

            await new Promise((resolve) => {
                const delay = 2000;
                setTimeout(() => {
                    resolve();
                }, delay);
            });

            const result = await chatGPTPage.evaluate(async () => {
                await chatgpt.isIdle();
                return {
                    all: await chatgpt.getChatData('active', 'all', 'chatgpt', 'latest'),
                    msg: await chatgpt.getChatData('active', 'msg', 'chatgpt', 'latest')
                };
            });

            let msg = Array.isArray(result.msg) ? result.msg.join("\n") : result.msg
            logger.info("response message: " + msg);
            res.json({
                "choices": [{
                    "finish_reason": "stop",
                    "index": 0,
                    "message": {
                        "content": msg,
                        "role": "assistant"
                    }
                }],
                "created": new Date(result.all.update_time).getTime(),
                "id": "chatcmpl-" + result.all.id,
                "model": "gpt-4",
                "object": "chat.completion",
                "system_fingerprint": null
            });

            browserManager.markPageAsIdle(chatGPTPage);
        } catch (error) {
            logger.error(error);
            browserManager.markPageAsIdle(chatGPTPage);
        }

        req.on('close', async () => {
            logger.info("stop");
            await chatGPTPage.evaluate(async () => {
                await chatgpt.stop();
            });
            browserManager.markPageAsIdle(chatGPTPage);
        });
    });
}


class BrowserManager extends EventEmitter {
    constructor(browser) {
        super(); // 初始化 EventEmitter
        this.browser = browser;
        this.pages = [];
        this.pageIdleFlags = [];
    }

    async initPages(pageCount) {
        const pagePromises = [];
        for (let i = 0; i < pageCount; i++) {
            // 收集所有页面创建的Promise
            pagePromises.push((async () => {
                const page = await this.browser.newPage();
                await page.goto("https://chat.openai.com/?model=gpt-4");
                await page.addScriptTag({
                    path: path.join(__dirname, 'chatgpt.js')
                });
                this.pages.push(page);
                this.pageIdleFlags.push(true); // 初始时，所有页面都标记为空闲
            })());
        }
        await Promise.all(pagePromises); // 等待所有页面都创建完成
    }

    async getFreePage() {
        // 尝试查找一个空闲的页面
        for (let i = 0; i < this.pageIdleFlags.length; i++) {
            if (this.pageIdleFlags[i]) {
                this.pageIdleFlags[i] = false; // 标记页面为忙碌
                return this.pages[i];
            }
        }
        // 如果没有找到空闲的页面，等待一个页面变为空闲
        return new Promise(resolve => {
            this.once('pageIdle', () => resolve(this.getFreePage()));
        });
    }

    markPageAsIdle(page) {
        const index = this.pages.indexOf(page);
        if (index !== -1) {
            this.pageIdleFlags[index] = true;
            this.emit('pageIdle'); // 触发页面空闲的事件
        }
    }
}

module.exports = completions;