# Mercado Livre Auto-Quotation System (Web Service)

Este projeto é um sistema completo de cotação automática que roda em Docker (ou localmente) e oferece uma interface Web para gerenciamento de tarefas. Ele utiliza **Puppeteer** para scraping do Mercado Livre e **DeepSeek AI (Reasoner V3.2)** para análise semântica e validação de itens de edital.

## Funcionalidades

- **Interface Web**: Painel para criar tarefas, colar CSVs e acompanhar logs em tempo real.
- **Processamento em Background**: Sistema de filas (Bull + Redis) para processar múltiplos itens de forma robusta.
- **Validação com IA Avançada**: Utiliza o modelo `DeepSeek-V3.2` para "pensar" sobre a compatibilidade dos produtos e atribuir um **Score de Risco (0-10)**.
- **Anti-Bloqueio**: Simulação humana (mouse/scroll), Stealth Plugin e suporte a Proxies (arquivo ou URL).
- **Relatório Excel**: Gera um arquivo `.xlsx` com duas abas: "Dados Brutos" e "Resumo".

## Pré-requisitos

- Node.js 18+ (para rodar localmente).
- Docker e Docker Compose (para rodar via container/servidor).
- Uma chave de API da DeepSeek.
- Redis (se rodar localmente sem Docker).

---

## 🚀 Como Rodar

### Opção 1: Rodar Localmente (Desenvolvimento)

Ideal para testar e debugar rapidamente no seu computador.

1.  **Instale o Redis**:
    - Windows: Use WSL2 ou baixe um binário do Redis.
    - Linux/Mac: `sudo apt install redis-server` ou `brew install redis`.
    - Inicie o Redis: `redis-server`.

2.  **Instale as Dependências**:
    ```bash
    npm install
    ```

3.  **Configure as Variáveis**:
    Defina sua chave da API.
    - Linux/Mac: `export DEEPSEEK_API_KEY="sua-chave"`
    - Windows (PowerShell): `$env:DEEPSEEK_API_KEY="sua-chave"`

4.  **Inicie o Sistema**:
    ```bash
    npm start
    ```
    Acesse: `http://localhost:3000`

### Opção 2: Rodar no Servidor (Produção / Docker)

Ideal para deixar rodando 24/7 em um servidor (VPS, AWS, DigitalOcean).

1.  **Configure o Ambiente**:
    Edite o arquivo `docker-compose.yml`.
    - Insira sua `DEEPSEEK_API_KEY` na seção environment.
    - Se usar proxy, descomente a linha `PROXY_URL`.

2.  **Arquivos Opcionais**:
    - `proxies.txt`: Crie na raiz se quiser rotação de IP (formato: `ip:porta` ou `user:pass@ip:porta` por linha).
    - `cookies.json`: Crie na raiz se quiser usar cookies de sessão (exportados via extensão EditThisCookie).

3.  **Subir o Serviço**:
    ```bash
    docker-compose up --build -d
    ```

4.  **Acessar**:
    Acesse pelo IP do servidor ou localhost: `http://localhost:3001` (Note a porta 3001 mapeada no docker-compose).

---

## 🔧 Solução de Problemas (Troubleshooting)

### Erro: "TLS handshake timeout" ou "UNAUTHORIZED" ao baixar imagem Docker
Se você ver erros como `failed to solve: node:18-slim ... TLS handshake timeout` ou `UNAUTHORIZED` ao rodar o docker build:

1.  **Verifique sua Conexão**: Isso geralmente é um bloqueio de rede (Firewall corporativo, VPN) ou instabilidade temporária no Docker Hub.
2.  **Reinicie o Docker**: `sudo systemctl restart docker` (Linux) ou reinicie o Docker Desktop.
3.  **Troque o DNS**: Tente usar o DNS do Google (8.8.8.8).
4.  **Autenticação Docker**: Tente fazer logout (`docker logout`) e tente novamente, pois `node:18-slim` é uma imagem pública e não requer login. Se estiver logado, suas credenciais podem estar expiradas.

### Erro 403 (Forbidden) no Mercado Livre
O IP foi marcado como bot.
- **Solução 1**: Adicione proxies válidos no `proxies.txt`.
- **Solução 2**: Importe cookies de uma conta real (logue no ML no seu chrome, exporte cookies para `cookies.json` na raiz do projeto).

---

## Estrutura do Projeto

- `server.js`: Servidor Web Express.
- `src/worker.js`: Processador de filas (Lógica principal).
- `src/scraper.js`: Navegação e extração de dados.
- `src/ai_validator.js`: Comunicação com a API DeepSeek.
- `views/`: Templates da interface (EJS).
- `prompts/`: Instruções de sistema para a I.A.
