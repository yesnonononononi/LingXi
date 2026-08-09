
from infrastructure.AgentBuilder import AgentBuilder

from infrastructure.entity.state import State


class AgentService:
    agentBuilder: AgentBuilder

    def __init__(self):
        self.agentBuilder = AgentBuilder()

    def chat(self, messages: State) -> dict:

        if msg := messages.get("messages", []):

            if len(msg) > 0:
                response = self.agentBuilder.chat(msg[-1].content)

                return {"messages": [response]}

        return {"messages":[]}


agentService = AgentService()