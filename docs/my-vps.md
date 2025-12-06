# **Documento de Contexto: Servidor Nextcloud AIO "Mabus"**

## **1\. Resumo Executivo**

Este documento detalha a arquitetura, configuração e histórico de um servidor dedicado que executa a imagem Docker **Nextcloud All-in-One (AIO)**. O sistema foi migrado de um VPS Ubuntu anterior para um servidor físico dedicado (self-hosted), também rodando Ubuntu. Osdomínio e proxy é gerenciado pelo NPMPlus em http://45.172.145.202:81. A interface do usuário é acessível por: https://sou.mabus.com.br

As principais particularidades desta instalação incluem:

1. **Migração Completa:** Uma migração bem-sucedida de VPS para servidor local foi realizada usando a ferramenta de backup e restauração **BorgBackup** integrada ao AIO.  
2. **Configuração de Rede Específica:** O servidor local utiliza uma configuração de IP estático complexa (/30) gerenciada via netplan.  
3. **Mapeamento de Volume Personalizado:** O volume de backup do AIO está mapeado para um caminho de host não padrão (/mnt/backup), um detalhe crucial que foi descoberto durante a depuração.  
4. **Conhecimento dos Procedimentos AIO:** O administrador (usuário) está ciente dos métodos de gerenciamento corretos específicos do AIO, como reiniciar e atualizar o mastercontainer em vez de gerenciar os serviços individualmente.

## **2\. Especificações do Servidor Físico (Pós-Migração)**

O hardware do servidor atual é robusto e serve como a base para a instância do Nextcloud.

### **2.1. Hardware**

* **Placa-Mãe:** X99 (m-ATX)  
* **CPU:** Intel Xeon E5-2680 V4 (14 núcleos / 28 threads @ 2.40GHz base)  
* **RAM:** 64GB DDR4 ECC (4x 16GB)  
* **Armazenamento:** 1TB SSD NVMe

### **2.2. Configuração de Rede do Host**

A rede do servidor é configurada manualmente usando netplan no Ubuntu. Esta é uma configuração de IP estático que se conecta diretamente a um link de internet externo.

* **Ferramenta de Configuração:** netplan  

* **Arquivo de Configuração:** /etc/netplan/50-cloud-init.yaml  

* **Nome da Interface:** Descoberto pelo administrador via ip addr show (ex: eth0, ens18).  

* **Configuração Lógica:**  
  
  * **Endereço IP:** 45.172.145.202  
  * **Máscara de Rede:** 255.255.255.252 (Notação CIDR: /30)  
  * **Gateway:** 45.172.145.201  
  * **DNS Servers:** \[8.8.8.8, 1.1.1.1\] (Servidores públicos do Google e Cloudflare).  

* **Conteúdo do /etc/netplan/50-cloud-init.yaml:**  
  network:  
    version: 2  
    renderer: networkd  
    ethernets:  
  
      NOME\_DA\_INTERFACE\_AQUI: \# O nome real da interface do servidor  
        dhcp4: no  
        addresses:  
          \- 45.172.145.202/30  
        routes:  
          \- to: default  
            via: 45.172.145.201  
        nameservers:  
          addresses: \[8.8.8.8, 1.1.1.1\]

## **3\. Arquitetura e Conceitos do Nextcloud AIO**

Esta instalação utiliza o Nextcloud AIO, que tem uma arquitetura de gerenciamento específica que difere fundamentalmente das instalações manuais.

* **Contêiner Mestre (nextcloud-aio-mastercontainer):** Este é o "cérebro" da instalação. É o único contêiner que o administrador deve gerenciar diretamente. Ele é responsável por iniciar, parar, atualizar e fazer backup de todos os outros contêineres de serviço (Nextcloud, Caddy, Postgres, Redis, etc.).  
* **Interface de Gerenciamento AIO (Porta 8080):** A única interface para gerenciamento de backup, restauração e atualização dos serviços. O usuário está ciente de que as atualizações do Nextcloud *não* devem ser feitas pela interface web do Nextcloud, mas sim por esta interface AIO.  
* **Proxy Reverso (Caddy):** O AIO gerencia seu próprio contêiner Caddy para lidar com o tráfego HTTPS, emissão automática de certificados SSL (Let's Encrypt) e roteamento de tráfego para os contêineres corretos.  
* **Contêiner de Backup (nextcloud-aio-borgmatic):** Um contêiner dedicado que usa o BorgBackup para criar backups deduplicados e criptografados de todo o sistema (arquivos e banco de dados).

## **4\. Histórico de Depuração e Migração**

O contexto mais valioso desta instalação vem de seu histórico de migração e depuração.

### **4.1. Problema Inicial: Disco Cheio (no VPS Antigo)**

O processo começou com o VPS antigo ficando sem espaço. As tentativas iniciais de localizar os arquivos grandes falharam devido a suposições incorretas sobre a estrutura de diretórios do AIO.

* **Tentativa Falha 1:** A suposição genérica de que os dados estariam em /var/www/html/data (caminho padrão do Snap/manual) estava incorreta. Este diretório continha apenas arquivos de configuração.  
* Método de Descoberta Correto: A localização real do datadirectory foi determinada programaticamente, inspecionando o config.php do contêiner:  
  docker exec \-u www-data nextcloud-aio-nextcloud cat /var/www/html/config/config.php | grep datadirectory  
* Este método foi estabelecido como o procedimento padrão para localizar dados de usuário em qualquer instância AIO.

### **4.2. O Processo de Migração (VPS para Servidor Físico)**

A migração foi o evento definidor desta instalação, revelando particularidades críticas.

**Etapa 1: Criação do Backup (VPS Antigo)**

* O backup foi criado com sucesso usando a interface de gerenciamento AIO (porta 8080).  
* Os logs do backup indicaram que o repositório Borg estava em /mnt/borgbackup/borg (do ponto de vista do *contêiner*).

**Etapa 2: Transferência de Backup (Descoberta Crítica)**

* A tentativa de transferir os arquivos via rsync falhou inicialmente, pois o caminho /mnt/borgbackup não existia no *host* do VPS.  
* Comando de Descoberta: A verdadeira localização do host foi encontrada inspecionando o contêiner nextcloud-aio-borgmatic:  
  docker inspect nextcloud-aio-borgmatic | grep \-A 2 /mnt/borgbackup  
* Resultado (A Particularidade Chave):  
  "/mnt/backup:/mnt/borgbackup:rw",  
* **Conclusão:** Esta linha revelou que o administrador do VPS havia mapeado um caminho de host **personalizado** (/mnt/backup) para o volume do Borg. Esta é uma configuração não padrão.  
* Comando de Transferência Correto (Executado no Novo Servidor):  
  sudo rsync \-avP root@195.200.4.9:/mnt/backup/ /mnt/backup/

**Etapa 3: Natureza do Backup Borg**

* Durante a transferência, foi observado que o backup não era um único arquivo .zip, mas sim uma pasta (borg) contendo milhares de pequenos arquivos e diretórios (data/, index.XX, config, etc.).  
* **Contexto:** Foi esclarecido que esta é a estrutura de repositório padrão do BorgBackup, que armazena "chunks" de dados deduplicados e criptografados. A ferramenta de restauração do AIO é projetada para ler esta estrutura de repositório.

**Etapa 4: Restauração (Novo Servidor)**

* Após a instalação do Docker e do IP estático, uma nova instância limpa do nextcloud-aio-mastercontainer foi iniciada.  
* A interface AIO (porta 8080\) foi acessada.  
* Na seção "Backup & Restore", o **"Backup Path"** foi configurado como /mnt/backup (o caminho no *novo* host onde os arquivos foram copiados).  
* A senha do backup foi inserida, o backup foi detectado e a restauração foi concluída com sucesso.  
* O DNS do domínio foi então apontado para o novo IP (45.172.145.202).

## **5\. Procedimentos de Manutenção Estabelecidos**

Com base nesta migração e configuração, os seguintes procedimentos são considerados padrão para este servidor:

### **5.1. Para Reiniciar o Nextcloud AIO**

O método correto é reiniciar o contêiner mestre, que por sua vez gerencia a reinicialização dos outros serviços.  
sudo docker restart nextcloud-aio-mastercontainer

### **5.2. Para Atualizar (Upgrade) o Nextcloud**

As atualizações **não** devem ser feitas pela interface do Nextcloud. O procedimento AIO correto é:

1. **Backup:** Criar um novo backup pela interface AIO (porta 8080).  
2. Pull: Baixar a última imagem do mestre:  
   sudo docker pull nextcloud/all-in-one:latest  
3. Parar/Remover: Parar e remover o contêiner mestre antigo:  
   sudo docker stop nextcloud-aio-mastercontainer  
   sudo docker rm nextcloud-aio-mastercontainer  
4. **Recriar:** Iniciar um novo contêiner mestre com o comando docker run original.  
5. **Atualizar:** Acessar a interface AIO (porta 8080), que detectará as versões desatualizadas e fornecerá um botão para "Atualizar todos os contêineres".

## **6\. Pontos-Chave para Treinamento de IA**

* **AIO é uma "Caixa Preta" Gerenciada:** Os procedimentos padrão do Docker (como docker exec em um contêiner de aplicativo) são apenas para depuração. O gerenciamento real (backup, update, restart) deve passar pelo mastercontainer ou pela UI do AIO.  
* **Volumes de Host são Variáveis:** O docker inspect é a ferramenta definitiva para encontrar mapeamentos de volume do mundo real. Instâncias AIO podem ter caminhos de host personalizados (como /mnt/backup neste caso) que não são óbvios pelos logs do contêiner.  
* **Backup Borg não é um Arquivo Único:** O backup do AIO é um repositório Borg. A transferência de backup envolve copiar toda a estrutura do repositório (/borg/...).  
* **Migração AIO é Robusta:** O processo de Backup (via UI) \-\> Transferir (via rsync) \-\> Restaurar (via UI) é o método comprovado e bem-sucedido para migrações completas de servidor.  
* **Configuração de Rede Host:** O Netplan é a ferramenta padrão para rede no Ubuntu Server moderno, e a configuração de IP estático /30 (45.172.145.202/30) com um gateway (45.172.145.201) é um exemplo concreto de configuração de rede de produção.