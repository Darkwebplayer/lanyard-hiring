// Pure workflow types shared by the canvas (later) and the server. No I/O anywhere in shared/workflow.

export type FieldType = 'string' | 'text' | 'number' | 'boolean' | 'enum' | 'date' | 'file' | 'list'

// One readable value in the context, e.g. { path: 'nodes.ai.overall', type: 'number' }.
export interface Field {
  path: string
  type: FieldType
  label: string
  options?: string[] // enum
  protected?: boolean // never sent to AI
  nodeType?: string // for nodes.* fields: the type of the node that produced it
}

export interface FormField {
  key: string
  label: string
  type: FieldType
  required: boolean
  min?: number // number: value, string/text/list: length
  max?: number
  options?: string[] // enum
  protected?: boolean
}

export interface GraphNode {
  key: string
  type: string
  config: unknown
  position?: { x: number, y: number }
  label?: string
}

export interface GraphEdge {
  from: string
  to: string
  branch?: string // condition nodes only: a branch key, 'default' or 'missing'
}

export interface Graph {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

// The job fields every workflow can read as job.*
export interface JobContext {
  title: string
  min_experience_years?: number
  must_have_skills?: string[]
  salary_min?: number
  salary_max?: number
  location?: string
  employment_type?: string
  openings: number
}

// Assembled on demand at runtime, never stored: candidate.*, form.*, job.*, nodes.<key>.*
export interface Context {
  candidate: { first_name: string, last_name: string, email: string, phone?: string }
  form: Record<string, unknown>
  job: JobContext
  nodes: Record<string, Record<string, unknown>>
}

export interface Issue {
  node?: string // node key, so the canvas can mark it broken
  code: string
  message: string
}

export const KEY_RE = /^[a-z][a-z0-9_]{0,39}$/
