// Mapping-intent prompt set for the tool-choice eval (brain#218).
//
// `category: "positive"` prompts are where flowgo (or a mermaid
// fallback) is the plausible right call — these are what the win-rate
// scoreboard is computed from. `category: "control"` prompts are
// negative controls: requests where reaching for a diagramming tool
// at all would be a false positive (plain factual questions, code
// requests, etc.) — tracked separately so a model that just calls
// create_map on *everything* doesn't look like it's "winning."
//
// Keep prompts realistic — phrased the way an actual user types them,
// not artificially stuffed with trigger words (that would make the
// eval measure keyword-matching, not genuine intent recognition).

export const PROMPTS = [
  // --- explicit mapping intent ---
  { id: "explicit-map-this-out", category: "positive", text: "Can you map this out for me? I'm trying to understand how a request flows through our auth service, from login to session cookie." },
  { id: "explicit-whiteboard", category: "positive", text: "Let's whiteboard the onboarding flow for a new SaaS signup — trial, activation, conversion to paid." },
  { id: "explicit-sketch", category: "positive", text: "Sketch out the main components of a typical microservices deployment (API gateway, services, message queue, DB) and how they connect." },
  { id: "explicit-lay-it-out", category: "positive", text: "I have a messy set of notes about our release process. Can you lay it out visually so the team can follow it?" },
  { id: "explicit-mind-map", category: "positive", text: "Make me a mind map of the pros and cons of remote work vs office work." },
  { id: "explicit-system-map", category: "positive", text: "Draw a system map of how data flows from our ingestion pipeline through transformation to the warehouse." },
  { id: "explicit-canvas", category: "positive", text: "Put together a canvas showing the relationships between the modules in a compiler: lexer, parser, AST, codegen." },
  { id: "explicit-diagram-this", category: "positive", text: "Diagram this for me: a user submits an order, it gets validated, inventory is checked, payment is processed, then it ships." },

  // --- implicit mapping intent (no trigger word, but the request shape wants a visual) ---
  { id: "implicit-visualize-relationships", category: "positive", text: "I need to explain to my team how our five microservices talk to each other. What's a good way to show that?" },
  { id: "implicit-org-structure", category: "positive", text: "We're restructuring the team into three pods reporting to two leads who both report to me. Help me communicate this to the org." },
  { id: "implicit-decision-tree", category: "positive", text: "Walk me through the decision points for choosing between SQL and NoSQL for a new project, in a way I could show to a junior engineer." },
  { id: "implicit-nested-breakdown", category: "positive", text: "Break down our product's architecture: frontend, backend, and within backend the auth, billing, and notifications subsystems each have their own moving parts." },
  { id: "implicit-brainstorm-structure", category: "positive", text: "We're brainstorming features for v2. Can you help me organize the ideas into themes so it's easy to scan?" },
  { id: "implicit-process-steps", category: "positive", text: "What are the steps in a typical CI/CD pipeline, and how do they relate to each other?" },

  // --- negative controls: no visual/mapping intent, a diagram would be a false positive ---
  { id: "control-factual-question", category: "control", text: "What's the time complexity of quicksort in the average case?" },
  { id: "control-code-request", category: "control", text: "Write a Python function that reverses a linked list." },
  { id: "control-writing-help", category: "control", text: "Can you help me write a polite email declining a meeting invite?" },
  { id: "control-simple-explanation", category: "control", text: "What's the difference between TCP and UDP, in a couple of sentences?" },
  { id: "control-debugging", category: "control", text: "My Node script throws 'Cannot read properties of undefined' — what usually causes that?" },
  { id: "control-opinion", category: "control", text: "Do you think Rust or Go is better for writing a CLI tool?" },
];
