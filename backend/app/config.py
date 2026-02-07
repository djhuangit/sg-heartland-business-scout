from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    gemini_api_key: str = ""
    database_url: str = "postgresql+asyncpg://scout:scout@localhost:5432/scout"
    database_url_sync: str = "postgresql+psycopg2://scout:scout@localhost:5432/scout"

    class Config:
        env_file = ".env"


settings = Settings()
