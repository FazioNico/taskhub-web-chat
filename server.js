// 10.2 – Backend de chat : la clé API reste côté serveur, la réponse est streamée
import Anthropic from "@anthropic-ai/sdk";
import express from "express";

const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5-5";
const PORT = Number(process.env.PORT ?? 3000);
const TASKS_URL = process.env.TASKS_URL ?? "http://localhost:3001/tasks";
const MAX_MESSAGES = 40; // garde-fou : taille maximale de l'historique accepté
const MAX_TOOL_TURNS = 5; // garde-fou : nombre maximal d'allers-retours outil <-> modèle

const SYSTEM_PROMPT =
  "Tu es l'assistant de l'app TaskHub. Réponds en français, de façon concise. " +
  "Utilise l'outil get_pending_tasks pour consulter les tâches non terminées.";

const TOOLS = [
  {
    name: "get_pending_tasks",
    description:
      "Récupère les tâches TaskHub qui ne sont pas encore terminées (statut 'todo' ou 'in_progress'). " +
      "Chaque tâche contient : id, title, project, status, dueDate (peut être null).",
    input_schema: {
      type: "object",
      properties: {
        project: {
          type: "string",
          description: "Optionnel : ne retourner que les tâches de ce projet (ex. 'site-web').",
        },
      },
    },
  },
];

const app = express();
const client = new Anthropic(); // lit ANTHROPIC_API_KEY

app.use(express.json({ limit: "100kb" }));
app.use(express.static("public"));

/** Valide l'historique envoyé par le navigateur : ne jamais faire confiance au client */
function validateMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_MESSAGES) {
    return false;
  }
  return messages.every(
    (m) =>
      (m.role === "user" || m.role === "assistant") &&
      typeof m.content === "string" &&
      m.content.length > 0 &&
      m.content.length <= 10_000,
  );
}

/** Appelle le serveur de tâches et ne garde que celles qui ne sont pas terminées */
async function getPendingTasks({ project } = {}) {
  const response = await fetch(TASKS_URL, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) {
    throw new Error(`Le serveur de tâches a répondu ${response.status}`);
  }
  const tasks = await response.json();
  return tasks.filter((t) => t.status !== "done" && (!project || t.project === project));
}

/** Exécute un appel d'outil demandé par le modèle ; une erreur est renvoyée au modèle, pas au client */
async function runTool({ id, name, input }) {
  try {
    if (name !== "get_pending_tasks") {
      throw new Error(`Outil inconnu : ${name}`);
    }
    const tasks = await getPendingTasks(input);
    return { type: "tool_result", tool_use_id: id, content: JSON.stringify(tasks) };
  } catch (err) {
    console.error(err);
    return {
      type: "tool_result",
      tool_use_id: id,
      is_error: true,
      content: `Impossible de récupérer les tâches : ${err.message}`,
    };
  }
}

app.post("/api/chat", async (req, res) => {
  const { messages } = req.body ?? {};
  if (!validateMessages(messages)) {
    res.status(400).json({ error: "Historique de messages invalide" });
    return;
  }

  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  try {
    const conversation = [...messages];
    for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
      const stream = client.messages.stream({
        model: MODEL,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        tools: TOOLS,
        messages: conversation,
      });
      stream.on("text", (text) => res.write(text));
      const message = await stream.finalMessage();
      if (message.stop_reason !== "tool_use") break;

      const toolUses = message.content.filter((block) => block.type === "tool_use");
      conversation.push({ role: "assistant", content: message.content });
      conversation.push({ role: "user", content: await Promise.all(toolUses.map(runTool)) });
    }
  } catch (err) {
    console.error(err);
    res.write("\n[Erreur : la réponse n'a pas pu être générée]");
  }
  res.end();
});

app.listen(PORT, () => console.log(`Chat sur http://localhost:${PORT}`));
