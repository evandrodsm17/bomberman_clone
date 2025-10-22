Bomberman Multiplayer com Node.js

Um jogo multiplayer em tempo real, estilo Bomberman clássico, construído com Node.js, Express e WebSockets puros. Crie salas privadas, chame seus amigos (ou adicione bots controlados por IA!) e dispute para ver quem é o último sobrevivente.

Este projeto foi desenvolvido com foco em performance e baixo atrito, rodando inteiramente no navegador (desktop ou mobile) sem necessidade de instalações pelo lado do cliente.

Principais Features

Backend com Node.js: Servidor leve e performático usando ws (WebSockets) para comunicação em tempo real.

Frontend com HTML Canvas: Renderização fluida do jogo usando a API nativa do Canvas.

Sistema de Salas:

Crie salas privadas (com código de 4 dígitos).

Entre em salas existentes.

Lobby de espera com lista de jogadores.

Multiplayer de 1 a 5 Jogadores:

O Host (dono da sala) pode adicionar Bots para preencher vagas.

O Host controla o início da partida.

IA de Bots Avançada:

Bots não ficam parados: eles fogem de explosões (incluindo raios futuros), buscam power-ups e colocam bombas estrategicamente perto de paredes destrutíveis.

Morte Súbita: Se apenas bots restarem, eles recebem poder máximo para acelerar o fim da rodada.

Power-ups Clássicos:

💣 Bomba Extra: Aumenta o limite de bombas simultâneas.

🔥 Mais Fogo: Aumenta o raio da explosão.

👟 Atravessar Bombas: Permite ao jogador andar por cima de bombas.

Sistema de Jogo Completo:

Sistema de pontuação (primeiro a 5 vitórias vence).

Mapa gerado proceduralmente (paredes destrutíveis são aleatórias).

Geração de spawn segura (garante que o jogador não nasça preso).

Controles de Toque:

Interface opcional de controles de toque (D-pad e botão de ação) para jogabilidade em dispositivos móveis.

Suporte a movimento contínuo (segurar o botão).

Customização:

Jogadores escolhem seus nomes e emojis de personagem.

Cores são atribuídas automaticamente para evitar duplicatas.

🚀 Tecnologias Utilizadas

Backend:

Node.js

Express (para servir os arquivos estáticos)

ws (WebSocket) (para comunicação em tempo real)

uuid (para IDs de jogadores e salas)

Frontend:

HTML5 (Canvas)

CSS3 (para UI do lobby, placar e controles)

JavaScript (ES6+)

🎮 Como Rodar Localmente

Siga os passos abaixo para rodar o projeto na sua máquina.

Clone o repositório:

git clone [https://github.com/SEU_USUARIO/SEU_REPOSITORIO.git](https://github.com/SEU_USUARIO/SEU_REPOSITORIO.git)
cd SEU_REPOSITORIO


Instale as dependências:
(Você precisa ter o Node.js instalado)

npm install


Isso irá instalar express, ws e uuid, conforme definido no package.json.

Inicie o servidor:

npm start


Seu servidor estará rodando em http://localhost:3000.

Jogue!

Abra http://localhost:3000 no seu navegador.

Abra uma segunda aba (ou um navegador diferente) no mesmo endereço para simular outro jogador entrando na sua sala.

📋 Próximos Passos (To-Do)

O projeto está funcional, mas sempre há espaço para melhorias:

[ ] Spritesheets: Substituir os emojis por spritesheets animados para o movimento dos personagens.

[ ] Efeitos Sonoros: Adicionar áudio para explosões, coleta de power-ups e morte.

[ ] IA Caçadora: Melhorar a IA para "caçar" ativamente outros jogadores, e não apenas destruir paredes.

[ ] Mais Power-ups: Adicionar itens clássicos (chute, luva de arremesso, etc.).

[ ] "Power-downs": Adicionar itens negativos que podem sair das paredes.

📄 Licença

Este projeto é distribuído sob a licença MIT.
