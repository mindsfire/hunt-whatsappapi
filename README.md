# Hunt WhatsApp API

A Node.js server that provides a WhatsApp Business API integration for e-commerce product catalog browsing and ordering. This application allows customers to browse products, view details, and place orders directly through WhatsApp.

## Features

- **Product Catalog Browsing**: Browse products by categories/types
- **Product Details**: View detailed product information including images
- **Shopping Cart**: Add/remove items and manage quantities
- **Order Processing**: Place orders directly through WhatsApp
- **Admin Panel**: Manage products and view orders
- **Media Management**: Image handling with Google Cloud Storage
- **Google Sheets Integration**: Order logging and management

## Tech Stack

- **Runtime**: Node.js (v18+)
- **Framework**: Express.js
- **Database**: Google Cloud Firestore
- **Storage**: Google Cloud Storage
- **Authentication**: WhatsApp Business API
- **Deployment**: Google Cloud Platform (GCP)

## Prerequisites

- Node.js v18 or higher
- Google Cloud Platform account
- WhatsApp Business API access
- Firebase/Firestore project

## Environment Variables

Create a `.env` file in the root directory with the following variables:

```
# Server
PORT=8080

# WhatsApp
WHATSAPP_TOKEN=your_whatsapp_token
WA_VERIFY_TOKEN=your_verification_token

# Google Cloud
GOOGLE_APPLICATION_CREDENTIALS=path/to/your/service-account.json
GCLOUD_PROJECT=your-project-id
STORAGE_BUCKET=your-storage-bucket

# Optional: Sync shared secret for admin endpoints
SYNC_SHARED_SECRET=your_secure_secret
```

## Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/yourusername/hunt-whatsappapi.git
   cd hunt-whatsappapi
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Set up your environment variables in `.env`

4. Start the server:
   ```bash
   npm start
   ```

## API Endpoints

- `POST /webhook` - WhatsApp webhook endpoint
- `GET /healthz` - Health check endpoint
- `POST /sync-catalog` - Sync product catalog (admin)
- `GET /admin/export-products` - Export products to CSV (admin)

## Project Structure

- `server.js` - Main application entry point
- `firestore.js` - Firestore database operations
- `.deploy-commands.sh` - Deployment scripts
- `firebase.json` - Firebase configuration
- `firestore.indexes.json` - Firestore index configuration

## Deployment

1. Ensure all environment variables are set in your deployment environment
2. Run `npm install --production`
3. Start the server with `npm start`

For GCP deployment, you can use the provided `.deploy-commands.sh` script after configuring it with your project details.

## License

This project is proprietary and confidential.

## Support

For support, please contact the development team at [your-email@example.com]
