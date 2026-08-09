from application.nodes.AgentNode import agentService
from infrastructure.AgentBuilder import AgentBuilder

if __name__ == '__main__':
    agent = AgentBuilder()
    for chunk in agent.agent.stream({"messages": [{"role": "user", "content": "最近openai推出了什么模型?"}]},stream_mode="updates"):
        print(chunk)
        print("\n")

