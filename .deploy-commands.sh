# deploy to gcloud with the local source code
gcloud run deploy hunt-whatsappapi \
  --source . \
  --project hunt-whatsappapi \
  --region asia-south1 \
  --allow-unauthenticated \
  --env-vars-file=.env

# to stream the logs
gcloud alpha run services logs tail hunt-whatsappapi \
  --region asia-south1 \
  --project hunt-whatsappapi


# future commands coming soon

# deploy to gcloud with the local source code to prod
npm --prefix web ci && npm --prefix web run build

gcloud run deploy hunt-whatsappapi \
  --source . \
  --project prod-hunt-whatsappapi \
  --region asia-south1 \
  --allow-unauthenticated \
  --env-vars-file=.env

gcloud alpha run services logs tail hunt-whatsappapi \
  --region asia-south1 \
  --project prod-hunt-whatsappapi

# sync from cm
export SYNC_SHARED_SECRET=<changeme>
curl -X GET \
  "https://hunt-whatsappapi-876367554060.asia-south1.run.app/admin/sync-from-cm" \
  -H "X-Shared-Secret: $SYNC_SHARED_SECRET"