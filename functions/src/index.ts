import { defineSecret, defineString } from 'firebase-functions/params'
import { onSchedule } from 'firebase-functions/v2/scheduler'
import { postLunchMenu } from './lunch-menu.js'

// Non-secret configuration (safe to keep as plain params / env).
const restaurantId = defineString('RESTAURANT_ID')
const restaurantName = defineString('RESTAURANT_NAME', { default: '멀티캠퍼스' })
const mealTimeId = defineString('MEAL_TIME_ID')

// Secrets, managed via `firebase functions:secrets:set <NAME>`.
const mattermostWebhookUrl = defineSecret('MATTERMOST_WEBHOOK_URL')
const welstoryUsername = defineSecret('WELSTORY_USERNAME')
const welstoryPassword = defineSecret('WELSTORY_PASSWORD')

export const postLunchMenuScheduled = onSchedule(
  {
    schedule: '23 9 * * 1-5',
    timeZone: 'Asia/Seoul',
    region: 'asia-northeast3',
    secrets: [mattermostWebhookUrl, welstoryUsername, welstoryPassword],
  },
  async () => {
    await postLunchMenu({
      restaurantId: restaurantId.value(),
      restaurantName: restaurantName.value(),
      mealTimeId: mealTimeId.value(),
      mattermostWebhookUrl: mattermostWebhookUrl.value(),
      welstoryUsername: welstoryUsername.value(),
      welstoryPassword: welstoryPassword.value(),
    })
  }
)
