// Storage Service — re-exports from fileUpload
// Other modules (spaces, host, kyc) can import from here.
export {
  uploadImage,
  deleteFile,
  extractKeyFromUrl,
  validateImageFile,
  type UploadedFile,
  type UploadResult,
} from './fileUpload';
