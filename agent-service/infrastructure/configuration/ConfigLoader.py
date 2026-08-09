import logging
import os.path

from dotenv import load_dotenv

from infrastructure.error.ConfigNotFoundException import ConfigNotFoundException



def getConfig()->Config:
    try:
        load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), "..", "..","..", ".env"))
        baseUrl:str = os.getenv("DP_AGENT_BASEURL")
        key:str = os.getenv("DP_AGENT_API_KEY")
        chatModelName = os.getenv("DP_MODEL_CHAT")
        embeddingModelName = os.getenv("DP_MODEL_EMBEDDING")
        if baseUrl and key:
            return Config(key,baseUrl,chatModelName,embeddingModelName)
        raise ConfigNotFoundException()
    except Exception as e:
        logging.error(e)
        raise Exception("There is an a error during obtaining system configuration") from e

class Config:
    apiKey:str
    baseUrl:str
    chatModelName:str = "gpt-5.6-luna"
    embeddingModelName:str = "text-embedding-3-large"
    def __init__(self,apiKey:str,baseUrl:str,chatModelName:str,embeddingModelName:str):
        self.apiKey = apiKey
        self.baseUrl = baseUrl
        self.chatModelName = chatModelName
        self.embeddingModelName = embeddingModelName

config = getConfig()