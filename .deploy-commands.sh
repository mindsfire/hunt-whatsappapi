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
# 