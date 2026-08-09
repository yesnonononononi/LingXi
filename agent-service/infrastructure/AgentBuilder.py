import dataclasses

from langchain.agents import create_agent
from langchain.agents.middleware.types import AgentState, InputAgentState, OutputAgentState, ResponseT

from langchain_core.messages import AIMessage

from langchain_openai import ChatOpenAI
from langgraph.graph.state import CompiledStateGraph
from langgraph.typing import ContextT

from infrastructure.configuration.ConfigLoader import   Config, config
from infrastructure.error.ConfigNotFoundException import ConfigNotFoundException
from infrastructure.tools.Tool import tools, Tools

@dataclasses.dataclass
class AgentBuilder:
    config:Config
    chatModel:ChatOpenAI
    agent:CompiledStateGraph[AgentState[ResponseT],ContextT, InputAgentState, OutputAgentState]
    tools:Tools

    def __init__(self):
        self.config = config
        apiKey = self.config.apiKey
        self.chatModel = ChatOpenAI(model=self.config.chatModelName,api_key=apiKey,base_url=self.config.baseUrl,verbose=True)
        self.tools = tools
        self.buildChatAgent()
        pass


    def getChatModel(self):
        if not self.config.apiKey or not self.config.baseUrl:
            raise ConfigNotFoundException()
        if not self.chatModel:
            self.chatModel = ChatOpenAI(base_url=self.config.baseUrl,api_key=self.config.apiKey)
        return self.chatModel

    def chat(self, prompt: str) -> AIMessage:
        result = self.agent.invoke({"messages": [{"role": "user", "content": prompt}]})
        return result["messages"][-1]

    async def astream_chat(self, prompt: str):
        async for chunk, metadata in self.agent.astream(
            {"messages": [{"role": "user", "content": prompt}]},
            stream_mode="messages"
        ):
            if metadata.get("langgraph_node") == "model":
                if chunk.content:
                    yield chunk.content


    def buildChatAgent(self):
        self.agent = create_agent(model=self.chatModel, tools=self.tools.getTools())

