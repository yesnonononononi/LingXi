# app/main.py
import uvicorn
from fastapi import FastAPI


from api.AgentApi import router
from api.vo.result import Result

# 1. 创建 FastAPI 实例
app = FastAPI(
    title="Agent Service",
    description="AI Agent 接口",
    version="1.0.0"
)

# 2. 注册路由
app.include_router(router)

# 3. （可选）根路径，方便测试
@app.get("/")
async def root():
    return Result.successWithoutParam()

if __name__ == '__main__':
    uvicorn.run("main:app", host="localhost", port=8000, reload=True)