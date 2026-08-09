from fastapi import APIRouter
from starlette.responses import StreamingResponse

from api.vo.result import Result
from application.nodes.AgentNode import agentService

router = APIRouter(prefix="/agent", tags=["Agent"])


@router.get("/chat")
async def chat(userInput: str):
    if userInput:
        if len(userInput) > 0:
            res = agentService.agentBuilder.chat(userInput)
            print(res)
            return Result.success(res.content)
    return Result.error("请输入有效问题")


@router.get("/chat/stream")
async def chat_stream(userInput: str):
    if userInput:
        if len(userInput) > 0:
            async def event_generator():
                async for token in agentService.agentBuilder.astream_chat(userInput):
                    yield token
            return StreamingResponse(event_generator(), media_type="text/plain")
    return Result.error("请输入有效问题")
