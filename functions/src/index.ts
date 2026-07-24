import { defineSecret } from 'firebase-functions/params'
import { onSchedule } from 'firebase-functions/v2/scheduler'
import { logger } from 'firebase-functions'

// GitHub repo that owns the lunch-menu workflow, e.g. "HC-SF/JOBOB".
const GITHUB_REPOSITORY = 'HC-SF/JOBOB'
const DISPATCH_EVENT_TYPE = 'post-lunch-menu'

// Fine-grained PAT with "Contents: read and write" (or classic PAT with
// "repo") on GITHUB_REPOSITORY, managed via `firebase functions:secrets:set`.
const githubToken = defineSecret('GITHUB_DISPATCH_TOKEN')

export const triggerLunchMenuWorkflow = onSchedule(
  {
    schedule: '0 9 * * 1-5',
    timeZone: 'Asia/Seoul',
    region: 'asia-northeast3',
    secrets: [githubToken],
  },
  async () => {
    const response = await fetch(`https://api.github.com/repos/${GITHUB_REPOSITORY}/dispatches`, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${githubToken.value()}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({ event_type: DISPATCH_EVENT_TYPE }),
    })

    if (!response.ok) {
      const body = await response.text()
      throw new Error(`GitHub dispatch failed: ${response.status} ${response.statusText} - ${body}`)
    }

    logger.info(`Dispatched "${DISPATCH_EVENT_TYPE}" to ${GITHUB_REPOSITORY}`)
  }
)
