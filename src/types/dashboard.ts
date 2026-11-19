export interface DashboardUsage {
  requests: number
  requestsLimit: number
  neurons: number
  neuronsLimit: number
}

export interface DashboardData {
  usage: DashboardUsage
  memoryCount: number
  skillCount: number
  nextBriefingAt: number | null
  briefingTime: string | null
  briefingKeywords: string
  notify: { feishu?: string; telegram?: string }
}

export interface MemoryWall {
  memories: { slug: string; description: string }[]
  skills: { slug: string; name: string; description: string; useCount: number }[]
}

export interface BriefingPayload {
  keywords?: string
}
