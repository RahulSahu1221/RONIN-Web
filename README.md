<div align="center">

# RONIN WEB 🎌

### *Learn Japanese. Build Consistency. Master Every Lesson.*

A modern, interactive Japanese learning platform designed for JLPT preparation — combining vocabulary, kanji, spaced repetition, quizzes, games, and progress analytics in one focused learning space.

<br>

[![HTML5](https://img.shields.io/badge/HTML5-E34F26?style=for-the-badge&logo=html5&logoColor=white)](https://developer.mozilla.org/en-US/docs/Web/HTML)
[![CSS3](https://img.shields.io/badge/CSS3-1572B6?style=for-the-badge&logo=css3&logoColor=white)](https://developer.mozilla.org/en-US/docs/Web/CSS)
[![JavaScript](https://img.shields.io/badge/Vanilla_JavaScript-F7DF1E?style=for-the-badge&logo=javascript&logoColor=black)](https://developer.mozilla.org/en-US/docs/Web/JavaScript)
[![Supabase](https://img.shields.io/badge/Supabase-3ECF8E?style=for-the-badge&logo=supabase&logoColor=white)](https://supabase.com/)
[![PWA](https://img.shields.io/badge/PWA-5A0FC8?style=for-the-badge&logo=pwa&logoColor=white)](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps)
[![License: MIT](https://img.shields.io/badge/License-MIT-8BC34A?style=for-the-badge)](LICENSE)

<br>

**[Open Ronin Web](https://ronin-web-puce.vercel.app) · [Source Code](https://github.com/RahulSahu1221/ronin-web)**

</div>

---

## About Ronin

RONIN WEB is a personal Japanese-learning project built to make vocabulary practice more engaging, structured, and consistent.

Instead of relying on memorization alone, it combines revision scheduling, interactive activities, custom decks, and learning statistics to help learners track their progress over time.

## Features

- **Vocabulary & Kanji** — Study Japanese words and kanji through organized lessons.
- **Spaced Repetition (SRS)** — Review words according to their scheduled revision dates.
- **Quizzes & Games** — Reinforce learning through interactive practice.
- **Custom Decks** — Organize words into personalized study collections.
- **Analytics & Gamification** — Track learning activity, streaks, XP, achievements, and review progress.
- **Cloud Sync** — Sign in to synchronize supported learning progress across devices using Supabase.
- **Offline Support** — Progressive Web App features cache the application and supported resources for offline use.
- **Personalization** — Customize themes and selected learning preferences.
- **Responsive Interface** — Designed for convenient use across desktop and mobile screens.

## Tech Stack

| Technology | Purpose |
|---|---|
| HTML5 | Application structure |
| CSS3 | Styling, glass effects, animations, responsive layout |
| Vanilla JavaScript | Learning features and interactions |
| Supabase | Authentication and cloud progress synchronization |
| Service Worker | Caching and offline support |
| Terser & CleanCSS | JavaScript and CSS minification |

## Run Locally

**Prerequisites:** Git, Node.js, and npm.

1. Clone the repository:

   ```bash
   git clone https://github.com/RahulSahu1221/ronin-web.git
   cd ronin-web
   ```

2. Install dependencies:

   ```bash
   npm install
   ```

3. Build the optimized files:

   ```bash
   npm run build
   ```

4. Start the local server:

   ```bash
   npm start
   ```

5. Open **http://localhost:3000** in your browser.

The build script generates the minified JavaScript and CSS files used by the application.

## Testing

Run the available automated tests with:

```bash
npm test
```

To validate the learning-data files, run:

```bash
npm run check-data
```

## Deployment

RONIN WEB is deployed on Vercel and connected to GitHub for source control and deployment updates.

**Live application:** [ronin-web-puce.vercel.app](https://ronin-web-puce.vercel.app)

## Data & Privacy

- Learning progress is stored locally in the browser.
- Supabase provides authentication and cloud synchronization for supported progress data.
- Cloud access is protected by database Row Level Security (RLS) policies.
- The application uses a public Supabase client key; privileged service-role keys must never be exposed in client-side code.

## License

Distributed under the MIT License. See the [LICENSE](LICENSE) file for details.

---

<div align="center">

### 小さな一歩が、大きな進歩になる。

*Small steps lead to great progress.*

**RONIN WEB · Learn a little every day.**

</div>
