import express from 'express';
import bodyParser from 'body-parser';
import dotenv from 'dotenv';
import fetch from 'node-fetch';
dotenv.config();


if (!process.env.DIFY_API_URL) 
  throw new Error('DIFY API URL is required.');


const app = express();
app.use(bodyParser.json());


app.all('/*', (req, res, next) => {
    console.log(`--- ${new Date()} ---`);
    console.log(`[Request Body] ${JSON.stringify(req.body || {})}`);
    console.log(`[Request Header] ${JSON.stringify(req.headers)}`);
    console.log(`[Request Method] ${req.method}`);
    next();
})


app.post('/v1/chat/completions', async (req, res) => {
    const authHeader = req.headers['authorization'] || req.headers['Authorization'];
    // const jsonFunc = res.json;
    // res.json = (d) => {
    //     console.log(`[Return Json] ${JSON.stringify(d)}`);
    //     jsonFunc(d);
    // }
    if (!authHeader) {
        return res.status(401).json({
            code: 401,
            errmsg: 'Unauthorized.'
        })
    }
    else
    {
        const token = authHeader.split(' ')[1];
        if (!token) {
            return res.status(401).json({
                code: 401,
                errmsg: 'Unauthorized.'
            })
        }
    }
    try {
        // 由于dify采用conversation_id模式
        // 暂不支持连续对话 直接提取最后一句
        const data = req.body;
        const queryString = data.messages[data.messages.length-1].content;
        // const response = await axios({
        //     method: 'POST',
        //     url: process.env.DIFY_API_URL + '/chat-messages',
        //     headers: {
        //         'Content-Type': 'application/json',
        //         'Authorization': `Bearer ${authHeader.split(' ')[1]}`
        //     },
        //     data: {
        //         'inputs': {},
        //         'query': queryString,
        //         'response_mode': 'streaming',
        //         'conversation_id': '',
        //         'user': 'apiuser'
        //     },
        //     responseType: 'stream',
        //     decompress: false
        // });
        // console.log(response.data);
        const resp = await fetch(process.env.DIFY_API_URL + '/chat-messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${authHeader.split(' ')[1]}`
            },
            body: JSON.stringify({
                'inputs': {},
                'query': queryString,
                'response_mode': 'streaming',
                'conversation_id': '',
                'user': 'apiuser'
            })
        });
        console.log('Received response from DIFY API with status:', resp.status);

        res.setHeader('Content-Type', 'text/event-stream');
        /*
           --- DOESN'T WORK ---
           resp.body.pipe(res);
           res.write('[DONE]');
           res.end();
           --------------------
        */
        const stream = resp.body;
        let buffer = '';

stream.on('data', (chunk) => {
    console.log('Received chunk:', chunk.toString());

    buffer += chunk.toString();
    let lines = buffer.split('\n');

    for (let i = 0; i < lines.length - 1; i++) {
        let line = lines[i].trim();
        if (!line.startsWith('data:')) continue;
        line = line.slice(5).trim();

        let chunkObj;
        try {
            chunkObj = JSON.parse(line);
        } catch (error) {
            console.error("Error parsing chunk:", error);
            continue;
        }

        if (chunkObj.event === 'message') {
            if (chunkObj.message === '[DONE]') {
                res.write("data: [DONE]\n\n");
                res.end();
                return;
            }
            const chunkContent = JSON.parse(`"${chunkObj.answer}"`);
            const chunkId = chunkObj.id;
            const chunkCreated = chunkObj.created;
            res.write("data: " + JSON.stringify({
                "id": chunkId,
                "object": "chat.completion.chunk",
                "created": chunkCreated,
                "model": data.model,
                "choices": [
                    {
                        "index": 0,
                        "delta": {
                            "content": chunkContent
                        },
                        "finish_reason": null
                    }
                ]
            }) + "\n\n");
        } else if (chunkObj.event === 'agent_message') {
            const chunkContent = chunkObj.answer;
            const chunkId = `chatcmpl-${Date.now()}`;
            const chunkCreated = chunkObj.created_at;
            res.write("data: " + JSON.stringify({
                "id": chunkId,
                "object": "chat.completion.chunk",
                "created": chunkCreated,
                "model": data.model,
                "choices": [
                    {
                        "index": 0,
                        "delta": {
                            "content": chunkContent
                        },
                        "finish_reason": null
                    }
                ]
            }) + "\n\n");
        } else if (chunkObj.event === 'message_end') {
            const chunkId = `chatcmpl-${Date.now()}`;
            const chunkCreated = chunkObj.created_at;
            res.write("data: " + JSON.stringify({
                "id": chunkId,
                "object": "chat.completion.chunk",
                "created": chunkCreated,
                "model": data.model,
                "choices": [
                    {
                        "index": 0,
                        "delta": {},
                        "finish_reason": "stop"
                    }
                ]
            }) + "\n\n");
            res.write("data: [DONE]\n\n");
            res.end();
        } else {
            console.log('Unhandled event:', chunkObj.event);
        }
    }

    buffer = lines[lines.length - 1];
});
    } catch (error) {
        console.error("Error:", error);
    }
})

app.listen(process.env.PORT || 3000);