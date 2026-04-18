/**
 * Geocoding Service
 * Wrapper helper functions for the Google Maps JS SDK.
 */

export const reverseGeocode = async (
  lat: number,
  lng: number
): Promise<{ city: string; state: string; address: string; postcode?: string }> => {
  return new Promise((resolve, reject) => {
    if (typeof window === 'undefined' || !window.google?.maps?.Geocoder) {
      return reject(new Error('Google Maps JS SDK is not loaded.'));
    }

    const geocoder = new window.google.maps.Geocoder();
    geocoder.geocode({ location: { lat, lng } }, (results, status) => {
      if (status === 'OK' && results && results[0]) {
        const result = results[0];
        let city = '';
        let state = '';
        let postcode = '';

        result.address_components.forEach((comp) => {
          if (comp.types.includes('locality')) city = comp.long_name;
          if (comp.types.includes('administrative_area_level_1')) state = comp.long_name;
          if (comp.types.includes('postal_code')) postcode = comp.long_name;
        });

        resolve({
          city,
          state,
          postcode,
          address: result.formatted_address || '',
        });
      } else {
        reject(new Error(`Reverse geocoding failed: ${status}`));
      }
    });
  });
};

export const searchPlaces = async (
  query: string
): Promise<Array<{ id: string; primary: string; secondary: string; description: string }>> => {
  return new Promise((resolve, reject) => {
    if (typeof window === 'undefined' || !window.google?.maps?.places) {
      return reject(new Error('Google Maps Places SDK is not loaded.'));
    }

    const autocompleteService = new window.google.maps.places.AutocompleteService();
    
    autocompleteService.getPlacePredictions(
      { input: query, componentRestrictions: { country: 'in' } },
      (predictions, status) => {
        if (status === window.google.maps.places.PlacesServiceStatus.ZERO_RESULTS) {
          return resolve([]);
        }

        if (status !== window.google.maps.places.PlacesServiceStatus.OK || !predictions) {
          return reject(new Error(`Place search failed: ${status}`));
        }

        const formatted = predictions.map((item) => ({
          id: item.place_id,
          primary: item.structured_formatting.main_text,
          secondary: item.structured_formatting.secondary_text,
          description: item.description,
        }));

        resolve(formatted);
      }
    );
  });
};
