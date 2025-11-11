gcloud run deploy hunt-whatsappapi \
  --source . \
  --project hunt-whatsappapi \
  --region asia-south1 \
  --allow-unauthenticated \
  --env-vars-file=.env