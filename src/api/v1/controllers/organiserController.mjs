import * as requests from '../../../services/organisers/requests.mjs';

/** POST /organisers/requests (public, rate limited per IP) → { id, status } */
export const submitRequest = async (req, res) => {
    res.status(201).json({ data: await requests.submitRequest(req.body) });
};

/** GET /organisers/requests (Studio) */
export const listRequests = async (req, res) => {
    res.json({ data: await requests.listRequests() });
};

/** PATCH /organisers/requests/:id (Studio) */
export const updateRequest = async (req, res) => {
    res.json({ data: await requests.updateRequest(req.params.id, req.body) });
};
