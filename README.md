# Speak Zeta

<div align="center">

**Una aplicacion de voz y chat en tiempo real inspirada en Discord, construida con React y FastAPI.**

[![License: MIT](https://img.shields.io/badge/License-MIT-7289da.svg)](LICENSE)
[![Python](https://img.shields.io/badge/Python-3.12-3776AB?logo=python&logoColor=white)](https://python.org)
[![React](https://img.shields.io/badge/React-18.3-61DAFB?logo=react&logoColor=black)](https://reactjs.org)
[![Docker](https://img.shields.io/badge/Docker-Ready-2496ED?logo=docker&logoColor=white)](https://docker.com)
[![FastAPI](https://img.shields.io/badge/FastAPI-0.115-009688?logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com)

</div>

---

## Que es Speak Zeta?

Speak Zeta es un clon funcional de Discord que permite comunicacion en tiempo real mediante chat de texto y voz peer-to-peer. Usa WebRTC para audio y compartir pantalla, WebSockets para mensajeria instantanea, y tiene un diseno oscuro inspirado en Discord.

### Funcionalidades

- **Chat de texto** en multiples salas con historial de mensajes
- **Chat de voz** peer-to-peer con WebRTC (baja latencia)
- **Compartir pantalla** en tiempo real durante sesiones de voz
- **Gestion de salas** - crea y administra salas de texto y voz
- **Presencia de usuarios** - ve quien esta conectado en cada sala
- **Controles de audio avanzados** - seleccion de microfono, volumen, supresion de ruido, cancelacion de eco
- **Push-to-Talk (PTT)** y deteccion de actividad de voz (VAD)
- **Control de volumen por usuario** - ajusta el volumen de cada participante
- **Notificaciones TTS** - anuncios por voz cuando alguien entra o sale
- **Indicador visual de habla** - animacion en anillo para quien esta hablando
- **Persistencia local** - recuerda tu nombre de usuario, dispositivos y preferencias

---

## Tech Stack

| Capa | Tecnologia |
|------|-----------|
| **Frontend** | React 18, CSS3 (tema oscuro), WebRTC, Web Audio API |
| **Backend** | Python 3.12, FastAPI, WebSockets, Pydantic |
| **Infraestructura** | Docker, Docker Compose, Nginx (Alpine) |
| **Comunicacion** | WebSockets (chat), WebRTC (voz/pantalla), STUN servers |

---

## Inicio Rapido

### Prerequisitos

- [Docker](https://docs.docker.com/get-docker/) y [Docker Compose](https://docs.docker.com/compose/install/)

### Despliegue con Docker (recomendado)

```bash
# 1. Clona el repositorio
git clone https://github.com/ramzeta/speak-zeta.git
cd speak-zeta

# 2. Levanta los servicios
docker-compose up -d

# 3. Abre en tu navegador
# http://localhost
```

Eso es todo. La app estara corriendo en el puerto 80.

### Desarrollo Local

Si prefieres ejecutar sin Docker para desarrollo:

**Backend:**
```bash
cd backend
pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8000 --ws-max-size 16384
```

**Frontend:**
```bash
cd frontend
npm install
npm start
# Abre http://localhost:3000
```

---

## Arquitectura

```
speak-zeta/
├── docker-compose.yml           # Orquestacion de servicios
├── backend/
│   ├── Dockerfile               # Python 3.12 slim
│   ├── requirements.txt
│   └── app/
│       └── main.py              # API FastAPI + WebSocket handlers
├── frontend/
│   ├── Dockerfile               # Build con Node.js + Serve con Nginx
│   ├── nginx.conf               # Configuracion Nginx con headers de seguridad
│   ├── package.json
│   └── src/
│       ├── App.js               # Componente principal React
│       ├── App.css              # Estilos (tema Discord)
│       └── index.js             # Entry point
```

### Como funciona

```
┌─────────────┐     WebSocket      ┌──────────────┐
│   Frontend   │◄──────────────────►│   Backend    │
│   (React)    │   /ws/{sala}/{usr} │  (FastAPI)   │
│              │                    │              │
│   Nginx :80  │   REST API         │  Uvicorn     │
│              │◄──────────────────►│  :8000       │
└──────┬───────┘                    └──────────────┘
       │
       │  WebRTC (P2P)
       │  Audio + Pantalla
       ▼
┌─────────────┐
│  Otro Peer  │
└─────────────┘
```

- **Mensajes de texto**: viajan por WebSocket a traves del backend
- **Audio y pantalla**: conexion directa entre peers via WebRTC (el backend solo hace signaling)

---

## API

| Metodo | Endpoint | Descripcion |
|--------|----------|-------------|
| `GET` | `/api/rooms` | Lista todas las salas con usuarios conectados |
| `GET` | `/api/rooms/{sala}/messages` | Historial de mensajes de una sala |
| `POST` | `/api/rooms` | Crear nueva sala (texto o voz) |
| `GET` | `/health` | Health check |
| `WS` | `/ws/{sala}/{usuario}` | WebSocket para chat de texto |
| `WS` | `/ws/voice/{sala}/{usuario}` | WebSocket para signaling de voz |

---

## Configuracion

### Limites por defecto

| Parametro | Valor |
|-----------|-------|
| Largo maximo de mensaje | 2000 caracteres |
| Nombre de usuario | 1-20 caracteres alfanumericos |
| Salas de texto max | 50 |
| Salas de voz max | 20 |
| Usuarios por sala | 50 |
| Rate limit | 5 mensajes/segundo |

### Salas predeterminadas

- **Texto**: `general`, `random`, `tech`
- **Voz**: `voz-general`, `gaming`

### Personalizar origenes permitidos

Edita `backend/app/main.py`:

```python
ALLOWED_ORIGINS = [
    "https://tu-dominio.com",
    "http://localhost:3000",
]
```

---

## Seguridad

La app incluye varias medidas de seguridad:

- Contenedores Docker con usuario no-root
- Filesystem de solo lectura con tmpfs minimos
- Headers de seguridad en Nginx (CSP, X-Frame-Options, XSS-Protection)
- Validacion de origen en WebSockets
- Limites de recursos en contenedores (256MB backend, 128MB frontend)
- Rate limiting por usuario
- Validacion y sanitizacion de inputs

---

## Contribuir

Las contribuciones son bienvenidas! Asi puedes colaborar:

1. **Fork** el repositorio
2. **Crea una rama** para tu feature:
   ```bash
   git checkout -b feature/mi-nueva-funcionalidad
   ```
3. **Haz commit** de tus cambios:
   ```bash
   git commit -m "Agrega mi nueva funcionalidad"
   ```
4. **Push** a tu rama:
   ```bash
   git push origin feature/mi-nueva-funcionalidad
   ```
5. **Abre un Pull Request**

### Ideas para contribuir

- [ ] Persistencia con base de datos (actualmente todo es en memoria)
- [ ] Autenticacion de usuarios
- [ ] Mensajes directos (DMs)
- [ ] Emojis y reacciones
- [ ] Subida de archivos e imagenes
- [ ] Servidor TURN propio para mejorar conectividad WebRTC
- [ ] Soporte multi-idioma (i18n)
- [ ] Temas personalizables
- [ ] Notificaciones push
- [ ] Tests unitarios y de integracion

---

## Licencia

Este proyecto es open source bajo la [Licencia MIT](LICENSE).

---

<div align="center">

Hecho con mass por la comunidad

[Reportar Bug](https://github.com/ramzeta/speak-zeta/issues) · [Solicitar Feature](https://github.com/ramzeta/speak-zeta/issues)

</div>
